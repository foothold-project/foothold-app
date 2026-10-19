// Real flat wire objects. These literals are validated by Python and JSON Schema too.
import type { ScreenCmd, ScreenMessage, ScreenLeaseUpdate, ScreenLeaseResult, ScreenReply, AgentState, AgentStop, AgentHello } from '../ts/index';
export const command: ScreenCmd = {"t":"cmd","id":"cmd","robot":"00000000-0000-0000-0000-000000000001","lease_id":"00000000-0000-0000-0000-000000000002","seq":1,"axes":[0,0,0]};
export const subsequent: ScreenMessage = {"t":"ping","id":"followup"};
export const first: ScreenMessage = {"t":"ping","id":"first","proto":"fh-rt/1"};
export const observer: ScreenLeaseUpdate = {"t":"lease","robot":"00000000-0000-0000-0000-000000000001","holder":null,"since":null};
export const success: ScreenLeaseResult = {"t":"lease.result","robot":"00000000-0000-0000-0000-000000000001","request_id":null,"result":"ACCEPTED"};
export const reply: ScreenReply = {"t":"reply","id":"stop","ok":true};
export const stopped: AgentState = {"t":"state","pose":{"floor_id":null,"x":null,"y":null,"yaw":null,"confidence":null},"speed":null,"battery":{"soc":null},"latched":true,"stop_gen":3,"stop_ref":2,"applied":[0,0,0],"mode":"FREE"};
export const stop: AgentStop = {"t":"stop","by_user_id":null,"stop_ref":2};
// @ts-expect-error An omitted followup proto is allowed; explicit null is invalid.
const nullProto: ScreenMessage = {t:'ping',id:'bad',proto:null};
void [command, subsequent, first, observer, success, reply, stopped, stop, nullProto];
// @ts-expect-error The server always sends the response envelope tag.
const missingReplyTag: ScreenReply = {id:'tag',ok:true};
void missingReplyTag;

export const agentHello: AgentHello = {"t":"hello","proto":"fh-agent/2","agent_version":"0.2.0","robot_model":null,"firmware":null,"devices":[],"map_versions":[],"last_floor_id":null,"latched":true,"stop_gen":1,"lease_id":null,"run":null};
// @ts-expect-error The previous agent proto cannot claim the mandatory stop_ref contract.
const oldAgentProto: AgentHello = {...agentHello, proto:'fh-agent/1'};
void [agentHello, oldAgentProto];

import type { ScreenServerPing } from '../ts/index';
export const serverPing: ScreenServerPing = {"t":"ping","t_server":"2026-10-20T00:00:00Z"};
export const cancelRequest: ScreenMessage = {"t":"lease.cancel","id":"cancel","robot":"00000000-0000-0000-0000-000000000001"};
void [serverPing, cancelRequest];
