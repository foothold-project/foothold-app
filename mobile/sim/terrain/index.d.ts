export type TerrainItem = {x:number; y:number; yaw:number} & (
  | {kind:'box'; sx:number; sy:number; h:number}
  | {kind:'stairs'; width:number; steps:number; rise:number; run:number}
  | {kind:'ramp'; length:number; width:number; h:number}
  | {kind:'gap'; length:number; width:number});
export interface TerrainSpec {
  schema:'fh_custom_terrain/1'; id:string; name:string;
  size:[number,number]; spawn:[number,number,number]; items:TerrainItem[];
}
export interface TerrainIssue {item?:number; msg:string}
export interface TerrainMap {
  res:number; origin:[number,number,number]; w:number; h:number;
  floor_z:number; spawn_xyyaw:[number,number,number]; spawn_z:number; px:string;
}
export interface BuiltTerrain {
  xml:string;
  scene:{meshes:Record<string,{p:number[];i:number[]}>;models:{name:string;mesh:string;pos:number[];quat:number[];color:number[]}[]};
  map:TerrainMap;
  top:{bounds:number[];px:number[];map:{origin:number[];res:number;w:number;h:number};svg:string};
}
export const SCHEMA:'fh_custom_terrain/1';
export const CLEARANCE:0.45;
export function validateTerrain(spec:unknown):{errors:TerrainIssue[];warnings:TerrainIssue[]};
export function buildTerrain(spec:TerrainSpec):BuiltTerrain;
export function loadCustomTerrain(storage:Pick<Storage,'getItem'>,id:string|null):BuiltTerrain;
