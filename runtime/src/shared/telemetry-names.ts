// Fixed SQL fragments for the common telemetry resource columns, never user SQL.
export const readableMachineSQL = "coalesce(nullIf(JSONExtractString(resource_json,'host.name'),''),nullIf(attributes['machine_name'],''),nullIf(attributes['hostname'],''),'未命名主机')";
export const agentSeriesSQL = `concat(${readableMachineSQL},' · ',substring(agent_id,1,8))`;
export const machineSeriesSQL = `concat(${readableMachineSQL},' · ',substring(coalesce(nullIf(host_id,''),agent_id),1,8))`;
export const sdkSeriesSQL = `concat(service,' / ',${readableMachineSQL},' · ',substring(instance_id,1,8))`;
