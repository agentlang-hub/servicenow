module servicenow

import "resolver.js" @as r

entity incident {
    sys_id String @id,
    data Any @optional
}

entity task {
    sys_id String @id,
    data Any @optional
}

event assignIncident {
    sys_id String,
    user Email
}

workflow assignIncident {
    r.assignIncident(assignIncident.sys_id, assignIncident.user)
}

event assignTask {
    sys_id String,
    user Email
}

workflow assignTask {
    r.assignTask(assignTask.sys_id, assignTask.user)
}

workflow getIncidents {
    {incident? {}}
}

workflow getTasks {
    {task? {}}
}

resolver servicenowincident [servicenow/incident] {
    update r.updateInstance,
    query r.queryInstances,
    subscribe r.subs
}

resolver servicenowtask [servicenow/task] {
    update r.updateInstance,
    query r.queryInstances,
    subscribe r.subs
}