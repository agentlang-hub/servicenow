module servicenow

import "resolver.js" as r

entity incident {
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

workflow getIncidents {
    {incident? {}}
}

resolver servicenow ["servicenow/incident"] {
    update r.updateInstance,
    query r.queryInstances,
    subscribe r.subs
}
