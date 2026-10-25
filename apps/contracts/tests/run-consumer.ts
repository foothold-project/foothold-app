import type { PhoneMessage, PhoneRunStart, PhoneRunControl, PhoneRunUpdate, RunRecorded, PhoneTicketClaims, RunStatus, RunRecordStatus, AgentRunUpdate, RunStarted, AgentScenario, ServerAgentMessage } from '../ts/index';

export const runStart: PhoneRunStart = {"t":"run.start","id":"start","robot":"00000000-0000-0000-0000-000000000001","lease_id":"00000000-0000-0000-0000-000000000001","run_id":"00000000-0000-0000-0000-000000000001","screen_id":"00000000-0000-0000-0000-000000000001","scenario_id":"00000000-0000-0000-0000-000000000001","scenario_version":1,"floor_id":"00000000-0000-0000-0000-000000000001","map_version_id":"00000000-0000-0000-0000-000000000001"};
export const cancel: PhoneRunControl = {"t":"run.control","id":"cancel","robot":"00000000-0000-0000-0000-000000000001","run_id":"00000000-0000-0000-0000-000000000001","op":"abort"};
export const paused: PhoneRunUpdate = {"t":"run.update","run_id":"00000000-0000-0000-0000-000000000001","status":"PAUSED","step":0,"progress":{"done":0,"total":1},"wait_reason":"LINK_LOST","fail_code":null};
export const receipt: RunRecorded = {"t":"run.recorded","agent_instance_id":"00000000-0000-0000-0000-000000000001","report_seq":1};
export const signedViewer: PhoneTicketClaims = {"iss":"fh-control","aud":"fh-phone/1","org":"00000000-0000-0000-0000-000000000001","robot":"00000000-0000-0000-0000-000000000001","sub":"00000000-0000-0000-0000-000000000001","device":"00000000-0000-0000-0000-000000000001","purpose":"view","surface":"pc","iat":0,"exp":600,"jti":"00000000-0000-0000-0000-000000000001","run_cancel":true};
const direct: PhoneMessage = runStart;
export const legacyAgent: AgentRunUpdate = {"t":"run.update","run_id":"00000000-0000-0000-0000-000000000001","status":"RUNNING","step":0,"progress":null};
export const started: RunStarted = {"run_id":"00000000-0000-0000-0000-000000000001","scenario_id":"00000000-0000-0000-0000-000000000001","scenario_version":3,"floor_id":"00000000-0000-0000-0000-000000000001","map_version_id":"00000000-0000-0000-0000-000000000001","user_id":"00000000-0000-0000-0000-000000000001","device_id":"00000000-0000-0000-0000-000000000001","surface":"pc","screen_id":"00000000-0000-0000-0000-000000000001","simulation":true};
export const scenario: AgentScenario = {"id":"00000000-0000-0000-0000-000000000001","number":3,"waypoints":[{"floor_id":"00000000-0000-0000-0000-000000000001","map_version_id":"00000000-0000-0000-0000-000000000001","x":1,"y":2,"yaw":0,"waypoint_ref":null,"mission_id":"00000000-0000-0000-0000-000000000001","mission_version":1,"mission_name":"순찰"}],"finish":{"mode":"STAY","target":null}};
const serverReceipt: ServerAgentMessage = receipt;
// @ts-expect-error RUN_STARTED data must never carry the reconnect secret.
const exposed: RunStarted = {...started, resume_token: 'secret'};
const oldRecord: RunRecordStatus = 'ABORTED';
// @ts-expect-error New direct execution never generates the legacy record spelling.
const oldDirect: RunStatus = 'ABORTED';
// @ts-expect-error A direct start carries references, never an arbitrary plan.
const injected: PhoneRunStart = {...runStart, plan: {segments: []}};
// @ts-expect-error Resume evidence is a secret string, not a boolean permission.
const fakeProof: PhoneRunControl = {...cancel, resume_token: true};
void [direct, oldRecord, oldDirect, injected, fakeProof, serverReceipt, exposed];
