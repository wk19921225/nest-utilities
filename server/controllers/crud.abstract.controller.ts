import {
  Body,
  CanActivate,
  Delete,
  ExecutionContext,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Patch
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Document } from "mongoose";
import { CrudPermission, NURequest } from "../../interfaces";
import { CrudPermissions } from "../../interfaces/crudPermissions.interface";
import { CrudService } from "../services/crud.abstract.service";

export abstract class CrudController<IModel extends Document> {
  constructor(
    private crudService: CrudService<IModel>,
    private permissions: CrudPermissions = {}
  ) {}

  @Post()
  async create(
    @Req() request: NURequest,
    @Body() model: IModel,
    ...args: any[]
  ): Promise<IModel> {
    this.checkPermissions(this.permissions.create, request["context"]);

    const created = await this.crudService.create(model as IModel, request);
    return await this.crudService.populate(created);
  }

  @Get()
  async getAll(@Req() request: NURequest, ...args: any[]): Promise<IModel[]> {
    this.checkPermissions(this.permissions.read, request["context"]);

    return await this.crudService.getAll(request);
  }

  @Get(":id")
  async get(
    @Req() request: NURequest,
    @Param() params: any,
    ...args: any[]
  ): Promise<IModel | null> {
    this.checkPermissions(this.permissions.read, request["context"]);

    const fetched = await this.crudService.get(params.id, request);
    return await this.crudService.populate(fetched as IModel);
  }

  @Get("many/:ids")
  async getMany(
    @Req() request: NURequest,
    @Param() params: any,
    ...args: any[]
  ): Promise<IModel[]> {
    this.checkPermissions(this.permissions.read, request["context"]);

    const fetched = await this.crudService.getMany(
      params.ids.split(","),
      request
    );
    return await this.crudService.populateList(fetched);
  }

  @Put()
  async put(
    @Req() request: NURequest,
    @Body() model: IModel,
    ...args: any[]
  ): Promise<IModel> {
    this.checkPermissions(this.permissions.update, request["context"]);

    const updated = await this.crudService.put(model as IModel, request);
    return await this.crudService.populate(updated);
  }

  @Patch()
  async patch(
    @Req() request: NURequest,
    @Body() model: IModel,
    ...args: any[]
  ): Promise<IModel> {
    this.checkPermissions(this.permissions.update, request["context"]);

    const updated = await this.crudService.patch(model as IModel, request);
    return await this.crudService.populate(updated);
  }

  @Delete(":id")
  async delete(
    @Req() request: NURequest,
    @Param() params: any,
    ...args: any[]
  ): Promise<IModel | null> {
    this.checkPermissions(this.permissions.delete, request["context"]);

    const deleted = await this.crudService.delete(params.id, request);
    return await this.crudService.populate(deleted as IModel);
  }

  /**
   * Check permissions based on the provided settings
   * @param permission
   */
  protected checkPermissions(
    permission: CrudPermission | undefined,
    context: ExecutionContext
  ): void {
    if (!permission) {
      return;
    }

    // execute the provided guards
    const clonedContext = Object.assign(
      Object.create(Object.getPrototypeOf(context)),
      context
    );
    clonedContext["metadata"] = permission.data;
    for (const guard of permission.guards) {
      const canActivate = (new guard(
        new Reflector()
      ) as CanActivate).canActivate(clonedContext);

      if (!canActivate) {
        throw new HttpException(
          "The session does not meet the requirements for this endpoint",
          HttpStatus.FORBIDDEN
        );
      }
    }
  }
}
