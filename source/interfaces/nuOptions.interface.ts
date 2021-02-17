import { IMongoConditions } from "./mongoConditions.interface";
import { INuRequest } from "./nuRequest.interface";

export interface INuOptions {
  sort?: string[];
  random?: boolean;
  skip?: number;
  limit?: number;
  select?: string[];
  distinct?: string;

  request?: INuRequest;
  filter?: IMongoConditions;
  populate?: string[];

  count?: boolean;
}
