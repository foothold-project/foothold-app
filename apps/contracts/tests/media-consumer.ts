import type { MediaVideoFrame, MediaPointCloudHeader, ExternalCameraViewRequest, ExecutionCapabilities, ExecutableAgentScenario, RunExecutedResults, PhotoUploadMetadata, AgentMessage, PhoneMessage, MediaMessage, PhoneRunStart, ExecutableRunGoal, AgentScenarioWaypoint } from '../ts/index';

export const video: MediaVideoFrame = {"robot":"00000000-0000-0000-0000-000000000001","epoch":1,"episode_id":"00000000-0000-0000-0000-000000000001","version":"media/1","seq":0,"captured_at":"2026-10-26T00:00:00Z","channel":"rgb","source":"d435i_rgb","frame":"camera_color_optical_frame","t":"media.video","mime":"image/jpeg","width":640,"height":360,"jpeg":"/9j/2Q=="};
export const points: MediaPointCloudHeader = {"robot":"00000000-0000-0000-0000-000000000001","epoch":1,"episode_id":"00000000-0000-0000-0000-000000000001","version":"media/1","seq":0,"captured_at":"2026-10-26T00:00:00Z","channel":"lidar","source":"l1","frame":"lidar_link","t":"media.points","map_version_id":null,"pose":null,"count":1,"truncated":false,"encoding":"xyz_f32le","byte_length":12};
export const view: ExternalCameraViewRequest = {"robot":"00000000-0000-0000-0000-000000000001","epoch":1,"episode_id":"00000000-0000-0000-0000-000000000001","t":"external.view","version":"observer/1","seq":1,"yaw":0.0,"pitch":0.0,"radius":2.0};
export const execution: ExecutionCapabilities = {"contract":"scenario/2","revision":1,"actions":[{"key":"wait","state":"SUPPORTED","reason":null},{"key":"photo.rgb","state":"SUPPORTED","reason":null},{"key":"photo.depth","state":"UNSUPPORTED","reason":"Depth photo is not implemented"}]};
export const scenario: ExecutableAgentScenario = {"id":"00000000-0000-0000-0000-000000000001","number":1,"waypoints":[{"floor_id":"00000000-0000-0000-0000-000000000001","map_version_id":"00000000-0000-0000-0000-000000000001","waypoint_ref":null,"x":1.0,"y":2.0,"yaw":0.0,"mission_id":"00000000-0000-0000-0000-000000000001","mission_version":1,"mission_name":"사진 대기","mission_steps":[{"action":"WAIT","params":{"seconds":30}},{"action":"PHOTO","params":{"camera":"rgb"}}],"required_capabilities":["wait","photo.rgb"]}],"finish":{"mode":"STAY"},"map_proofs":[{"floor_id":"00000000-0000-0000-0000-000000000001","map_version_id":"00000000-0000-0000-0000-000000000001","image_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","source_pgm_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","origin":[0.0,0.0,0.0],"resolution":0.05,"width":100,"height":100,"source":"SIMULATION","world_id":"warehouse","ros_floor_id":"f1"}],"run_contract":"scenario/2","execution_capability_revision":1};
export const results: RunExecutedResults = {"mode":"EXECUTED","run_contract":"scenario/2","execution_capability_revision":1,"steps":[{"step_idx":0,"action":"WAIT","source":null,"status":"SUCCEEDED","failure_code":null,"failure_reason":null,"photo":null},{"step_idx":1,"action":"PHOTO","source":"rgb","status":"SUCCEEDED","failure_code":null,"failure_reason":null,"photo":{"photo_id":"00000000-0000-0000-0000-000000000001","source":"rgb","captured_at":"2026-10-26T00:00:00Z","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}]};
export const upload: PhotoUploadMetadata = {"org_id":"00000000-0000-0000-0000-000000000001","robot_id":"00000000-0000-0000-0000-000000000001","run_id":"00000000-0000-0000-0000-000000000001","waypoint_idx":0,"step_idx":1,"source":"rgb","captured_at":"2026-10-26T00:00:00Z","mime":"image/jpeg","byte_length":4,"sha256":"32461d5bd1773012acef0ba15636752949bd7c2ce50f9172159d9f56cf0dd9af","idempotency_key":"run:waypoint:step"};
const media: MediaMessage = video;
// @ts-expect-error Media payloads never enter the safety socket union.
const safety: AgentMessage = video;
// @ts-expect-error Observer drag never enters the driving socket union.
const driving: PhoneMessage = view;
// @ts-expect-error Legacy start cannot silently select executable scenario/2.
const silentUpgrade: PhoneRunStart = {t:'run.start.v2'};
declare const legacy: AgentScenarioWaypoint;
// @ts-expect-error A legacy display waypoint does not guarantee executable fixed steps.
const missingSteps: ExecutableRunGoal = {...legacy, idx: 0};
// @ts-expect-error JPEG photo upload cannot claim depth support.
const depth: PhotoUploadMetadata = {...upload, source: 'depth'};
void [media, safety, driving, silentUpgrade, missingSteps, depth];
