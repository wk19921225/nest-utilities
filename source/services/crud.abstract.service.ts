import { Response } from "express";
import _isNil from "lodash/isNil";
import _merge from "lodash/merge";
import _mergeWith from "lodash/mergeWith";
import { Document, Model, ModelPopulateOptions } from "mongoose";
import { IMongoConditions, INURequest } from "../interfaces";
import { IMongoRequest } from "../interfaces/mongoRequest.interface";
import { isObjectID } from "../utilities";

export abstract class CrudService<IModel extends Document> {
  private static serviceMap: { [modelName: string]: CrudService<any> } = {};

  constructor(protected crudModel: Model<IModel>) {
    CrudService.serviceMap[crudModel.modelName] = this;
  }

  /**
   * Save a new modelItem
   * @param modelItem
   */
  public async create(
    modelItem: Omit<IModel, keyof Document>,
    request?: INURequest | any,
    ...args: any[]
  ): Promise<IModel> {
    // make sure no leftover id exists
    delete modelItem["_id"];

    let model = await this.onCreateRequest(modelItem, request);

    return new this.crudModel(model).save();
  }

  /**
   * Create a modelItem if it doesn't exist, merge it otherwise
   * @param modelItem
   */
  public async createOrPatch(
    modelItem: IModel,
    request?: INURequest | any,
    ...args: any[]
  ): Promise<IModel> {
    modelItem = (await this.onCreateRequest(modelItem, request)) as IModel;

    if (modelItem._id || modelItem.id) {
      const existing = await this.get(modelItem._id || modelItem.id);
      if (existing !== null) {
        return this.patch(modelItem);
      }
    }

    return this.create(modelItem);
  }

  /**
   * Get a modelItem by its id
   * @param id
   */
  public async get(
    id: string,
    mongoRequest: IMongoRequest = {},
    ...args: any[]
  ): Promise<IModel | null> {
    if (isObjectID(id) === false) {
      return null;
    }

    return this.findOne({ _id: id }, mongoRequest);
  }

  /**
   * Find a single model
   * @param mongoRequest
   */
  public async findOne(
    conditions: IMongoConditions<IModel> = {},
    mongoRequest: IMongoRequest = {}
  ): Promise<IModel | null> {
    mongoRequest.options = { ...mongoRequest.options, limit: 1 };

    const response = await this.find(conditions, mongoRequest);
    if (response.length) {
      return response[0];
    }

    return null;
  }

  /**
   * Counts the number of documents which should be returned with the given conditions.
   * If defined, the onFindRequest conditions will also be appended
   * @param conditions
   * @param mongoRequest
   */
  public async countDocuments(
    conditions: IMongoConditions<IModel> = {},
    mongoRequest: Pick<IMongoRequest, "request" | "filters"> = {}
  ): Promise<number> {
    // merge filters and conditions
    conditions = this.cast(
      _merge(conditions, mongoRequest.filters || {}, {
        $and: [{}, ...(await this.onFindRequest(mongoRequest.request))]
      })
    );

    return this.crudModel.collection.countDocuments(conditions);
  }

  /**
   * Find models
   * @param options
   */
  public async find(
    conditions: IMongoConditions<IModel> = {},
    mongoRequest: IMongoRequest = {}
  ): Promise<IModel[]> {
    // merge filters and conditions
    conditions = this.cast(
      _merge(conditions, mongoRequest.filters || {}, {
        $and: [{}, ...(await this.onFindRequest(mongoRequest.request))]
      })
    );

    if (mongoRequest.request?.context) {
      // store the amount of documents without limit in a response header
      const response = mongoRequest.request.context
        .switchToHttp()
        .getResponse<Response>();

      const numberOfDocuments = await this.countDocuments(conditions);

      response.header("X-total-count", numberOfDocuments.toString());
      response.header("Access-Control-Expose-Headers", [
        "X-total-count",
        (response.getHeader("Access-Control-Expose-Headers") || "").toString()
      ]);
    }

    // get field selection
    const projection = {};
    mongoRequest.options?.select
      ?.filter(field => !field.includes("."))
      .forEach(field => (projection[field] = 1));

    // get field sorting
    const sort = {};
    mongoRequest.options?.sort?.forEach(field => {
      const desc = field.startsWith("-");
      const cleanField = desc ? field.replace("-", "") : field;
      sort[cleanField] = desc ? -1 : 1;
    });

    // build population params
    if (mongoRequest.populate?.length === 0) {
      mongoRequest.populate = this.getReferenceVirtuals();
    }
    const populateOptions = await this.getPopulateParams(
      mongoRequest.populate || [],
      Object.keys(projection),
      mongoRequest.request
    );

    // execute a find query avoiding Mongoose
    const response = await this.crudModel.collection
      .find<IModel>(conditions, {
        skip: mongoRequest.options?.skip,
        limit: mongoRequest.options?.limit,
        sort,
        projection
      })
      .toArray();

    // hydrate and populate the response
    const models = response.map(model =>
      this.crudModel
        .hydrate(model)
        .populate(populateOptions)
        .execPopulate()
    );

    return Promise.all(models);
  }

  /**
   * Get multiple modelItems by their id
   * @param id
   */
  public getMany(
    ids: string[],
    mongoRequest: IMongoRequest = {},
    ...args: any[]
  ): Promise<IModel[]> {
    return this.find({ _id: { $in: ids } }, mongoRequest);
  }

  /**
   * Merge with an existing modelItem
   * @param modelItem
   */
  public async patch(
    modelItem: Partial<IModel>,
    request?: INURequest | any,
    ...args: any[]
  ): Promise<IModel> {
    const existing = await this.get(modelItem._id || modelItem.id || "");
    if (existing === null) {
      throw new Error("No model item found with the given id");
    }

    let model = { ...modelItem };
    model = await this.onUpdateRequest(model, request);

    // remove version number
    delete model.__v;

    return _mergeWith(existing, model, (obj, src) =>
      !_isNil(src) ? src : obj
    ).save();
  }

  /**
   * Overwrite the model item with the corresponding id
   * @param modelItem
   * @param args
   */
  public async put(
    modelItem: IModel,
    request?: INURequest | any,
    ...args: any
  ): Promise<IModel> {
    let model = { ...modelItem };
    model = (await this.onUpdateRequest(model, request)) as IModel;

    // remove version number
    delete model.__v;

    return this.crudModel.update({ _id: model._id || model.id }, model).exec();
  }

  /**
   * Delete a modelItem by its id
   * @param id
   */
  public async delete(
    id: string,
    request?: INURequest | any,
    ...args: any[]
  ): Promise<IModel | null> {
    if (isObjectID(id) === false) {
      return null;
    }
    const model = await this.get(id);
    if (!model) {
      return null;
    }

    await this.onDeleteRequest(model, request);

    return this.crudModel.findByIdAndRemove(id).exec();
  }

  /**
   * Find models and delete them
   * @param conditions
   */
  public async findAndDelete(
    conditions: Partial<IModel>,
    request?: INURequest | any,
    ...args: any[]
  ): Promise<(IModel | null)[]> {
    const found = await this.find(conditions);

    return await Promise.all(
      found.map(model => this.delete(model._id, request)!)
    );
  }

  /**
   * Returns an array with all referencing virtuals of the services' model
   */
  public getReferenceVirtuals(): string[] {
    const virtuals = (this.crudModel.schema as any).virtuals;

    return Object.keys(virtuals).filter(key => !!virtuals[key].options.ref);
  }

  /**
   * Returns the schema object of the services' model
   */
  public getSchema(): any {
    return this.crudModel.schema.obj;
  }

  /**
   * Populate a retrieved model
   * @param model
   */
  public async populate(
    model: IModel,
    paths: string[] = [],
    picks: string[] = [],
    request?: INURequest | any
  ): Promise<IModel> {
    if (!model.populate) {
      if (!model._id && !model.id) {
        return model;
      } else {
        return (await this.get(model._id || model._id, {
          populate: []
        }))!;
      }
    }

    // use given paths or the defaul referencing virtuals to populate
    paths = paths.length ? paths : this.getReferenceVirtuals();
    return model
      .populate(await this.getPopulateParams(paths, picks, request))
      .execPopulate();
  }

  /**
   * Populate a list of retrieved models
   * @param models
   */
  public populateList(
    models: IModel[],
    paths: string[] = [],
    picks: string[] = [],
    request?: INURequest | any
  ): Promise<IModel[]> {
    return Promise.all(
      models.map(model => this.populate(model, paths, picks, request))
    );
  }

  /**
   * This method is called when a create request has been initiated.
   * The model returned from the method will be used in the create call which allows you to alter the
   * object based on the rights of the requester or throw an (http)error if the request may not be completed.
   *
   * The request originates from Express and ideally contains a user object
   * to decide the right conditions.
   *
   * Override this method to use it.
   *
   * @param request the Express request originating from the controller
   * @param model the model which is to be created
   */
  public async onCreateRequest(
    model: Omit<IModel, keyof Document>,
    request?: INURequest | any
  ): Promise<Omit<IModel, keyof Document>> {
    return model;
  }

  /**
   * This method is called when a find or count request has been initiated.
   * The response should consist of an array of conditions which will be appended to the `$and` field of
   * the Mongoose query.
   *
   * The request originates from Express and ideally contains a user object
   * to decide the right conditions.
   *
   * Override this method to use it.
   *
   * @param request the Express request originating from the controller
   */
  public async onFindRequest(
    request?: INURequest | any
  ): Promise<IMongoConditions<IModel>[]> {
    return [];
  }

  /**
   * This method is called when an update request has been initiated.
   * The model returned from the method will be used in the update call which allows you to alter the
   * object based on the rights of the requester or throw an (http)error if the request may not be completed.
   *
   * The request originates from Express and ideally contains a user object
   * to decide the right conditions.
   *
   * Override this method to use it.
   *
   * @param request the Express request originating from the controller
   * @param model the new version of the model which is to be updated
   */
  public async onUpdateRequest(
    model: Partial<IModel>,
    request?: INURequest | any
  ): Promise<Partial<IModel>> {
    return model;
  }

  /**
   * This method is called when a delete request has been initiated.
   * The id of the model has been provided as param. This allows you to check if the user has the correct
   * rights and throw an error if the request may not be completed.
   *
   * The request originates from Express and ideally contains a user object
   * to decide the right conditions.
   *
   * Override this method to use it.
   *
   * @param request the Express request originating from the controller
   * @param id the id of the model the request is trying to delete
   */
  public async onDeleteRequest(
    model: IModel,
    request?: INURequest | any
  ): Promise<void> {}

  /**
   * Build and return recursive populate() params for Mongoose
   * @param paths
   * @param picks
   */
  private async getPopulateParams(
    paths: string[],
    picks: string[] = [],
    request?: INURequest | any
  ): Promise<ModelPopulateOptions[]> {
    return (
      await Promise.all(
        paths.map(path => this.deepPopulate(path, picks, request))
      )
    ).filter(param => param !== undefined) as ModelPopulateOptions[];
  }

  /**
   * Creates deep population options including select options
   *
   * @param path the current field including children
   * @param picks all picks defined in the select options
   * @param request the accompanying request
   * @param journey the passed fields so far
   */
  private async deepPopulate(
    path: string,
    picks: string[],
    request?: INURequest | any,
    journey: string[] = []
  ): Promise<ModelPopulateOptions | undefined> {
    if (!path) {
      return undefined;
    }

    // get the current position and remove it from the journey
    const pathParts = path.split(".");
    const currentPosition = pathParts.shift()!;

    // gather current pick selectors
    const selection = picks
      .map(pick => {
        // popping results in the pickParts containing the current layer
        const pickParts = pick.split(".");
        const field = pickParts.pop();

        if (pickParts.join(".") === [...journey, currentPosition].join(".")) {
          return field;
        }
        return undefined;
      })
      .filter(item => !!item);

    return {
      path: currentPosition,
      select: selection.join(" ") || undefined,
      match: {
        $and: [
          {},
          ...(await this.getPopulateConditions(
            [...journey, currentPosition].join("."),
            request
          ))
        ]
      },
      populate:
        (await this.deepPopulate(pathParts.join("."), picks, request, [
          ...journey,
          currentPosition
        ])) || []
    };
  }

  /**
   * Retrieve the correct match condition based on the attribute path
   * @param path
   * @param request
   */
  private async getPopulateConditions(
    path: string,
    request?: INURequest | any
  ): Promise<IMongoConditions<IModel>[]> {
    // no request means no user to authorize
    if (!request) {
      return [];
    }

    // iterate through the path to find the correct service to populate
    let service: CrudService<IModel> = this;
    let haystack = {
      ...service.crudModel.schema.obj,
      ...(service.crudModel.schema as any).virtuals
    };

    path.split(".").forEach(position => {
      if (haystack[position]) {
        haystack = haystack[position];

        // switch services if we encounter a reference
        const ref = haystack.options ? haystack.options.ref : haystack.ref;
        if (ref) {
          service = CrudService.serviceMap[ref];
          haystack = {
            ...service.crudModel.schema.obj,
            ...(service.crudModel.schema as any).virtuals
          };
        }
      }
    });

    return service.onFindRequest(request);
  }

  /**
   * Casts the values of the mongo conditions to their corresponding types
   * @param conditions
   */
  private cast(conditions: IMongoConditions): IMongoConditions {
    Object.keys(conditions).forEach(key => {
      const value = conditions[key];
      if (key.startsWith("$")) {
        return (conditions[key] = Array.isArray(value)
          ? value.map(item => this.cast(item))
          : this.cast(value));
      }

      // cast the value if a type is found
      const type = this.getFieldType(key);
      if (type) {
        // take sub-objects into account like $in
        if (typeof value === "object" && !Array.isArray(value)) {
          Object.keys(value).forEach(subKey => {
            if (!subKey.startsWith("$")) {
              return;
            }

            const subValue = value[subKey];
            conditions[key][subKey] = Array.isArray(subValue)
              ? subValue.map(v => this.castValue(v, type))
              : this.castValue(subValue, type);
          });
        } else {
          conditions[key] = Array.isArray(value)
            ? value.map(v => this.castValue(v, type))
            : this.castValue(value, type);
        }
      }
    });

    return conditions;
  }

  /**
   * Returns the type of the given field
   * @param path
   */
  public getFieldType(path: string): string | null {
    const field = path.split(".").pop();
    if (field === "_id") {
      return "ObjectId";
    }

    let object = this.getSchema();
    path.split(".").forEach(key => {
      if (!object) {
        return;
      }

      object = object[key];
      if (Array.isArray(object)) {
        object = object[0];
      }
      object = object?.type || object;
      object = object?.obj || object;
    });

    return object?.name || object?.schemaName || null;
  }

  /**
   * Cast the value to the given type
   *
   * supported types: String, Number, Date, Boolean, ObjectId
   *
   * @param value
   * @param type
   */
  private castValue(value: any, type: string): any {
    if (value === null || value === undefined) {
      return null;
    }

    if (Array.isArray(value) || typeof value === "object") {
      return value;
    }

    try {
      switch (type) {
        case "String":
          return value + "";
        case "Number":
          return +value;
        case "Date":
          return new Date(value);
        case "ObjectId":
          return require("bson-objectid")(value);
        case "Boolean":
          return [true, 1, "true", "1"].includes(value);
        default:
          return value;
      }
    } catch {
      return value;
    }
  }
}
