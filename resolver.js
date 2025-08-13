const al_http = await import(`${process.cwd()}/node_modules/agentlang/out/utils/http.js`)
const al_module = await import(`${process.cwd()}/node_modules/agentlang/out/runtime/module.js`)
const al_integmanager = await import(`${process.cwd()}/node_modules/agentlang/out/runtime/integrations.js`)

const encodeForBasicAuth = al_http.encodeForBasicAuth
const makeInstance = al_module.makeInstance
const isInstanceOfType = al_module.isInstanceOfType

function getConfig(k) {
    return al_integmanager.getIntegrationConfig('servicenow', k)
}

let instUrl = undefined

function getInstanceUrl() {
    if (instUrl == undefined) {
        instUrl = getConfig('url')
    }
    return instUrl
}

let stdHdrs = undefined

function makeStandardHeaders() {
    if (stdHdrs == undefined) {
        const username = getConfig('username')
        const password = getConfig('password')
        stdHdrs = {
            'Authorization': `Basic ${encodeForBasicAuth(username, password)}`,
            'Content-Type': 'application/json' // Add other headers as needed
        }
    }
    return stdHdrs
}

async function getComments(sysId) {
    const instanceUrl = getInstanceUrl()
    const apiUrl = `${instanceUrl}/api/now/table/sys_journal_field?sysparm_display_value=true&sysparm_query=element=comments^element_id=${sysId}`
    try {
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: makeStandardHeaders()
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} ${response.text} ${response.statusText}`);
        }

        const data = await response.json();
        return data.result
    } catch (error) {
        return []
    }
}

async function addComment(sysId, comment) {
    const instanceUrl = getInstanceUrl()
    const apiUrl = `${instanceUrl}/api/now/table/incident/${sysId}`
    const data = { comments: comment }
    try {
        const response = await fetch(apiUrl, {
            method: 'PATCH',
            headers: makeStandardHeaders(),
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const responseData = await response.json();
        return responseData;
    } catch (error) {
        return { error: error }
    }
}

async function getIncidents(sysId, count) {
    const instanceUrl = getInstanceUrl()
    const apiUrl = sysId ?
        `${instanceUrl}/api/now/table/incident/${sysId}` :
        `${instanceUrl}/api/now/table/incident?sysparm_limit=${count}&sysparm_query=active=true^ORDERBYDESCsys_created_on`;
    try {
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: makeStandardHeaders()
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} ${response.text} ${response.statusText}`);
        }

        const result = await response.json();
        const data = result.result
        for (let i = 0; i < data.length; ++i) {
            const d = data[i]
            const comments = await getComments(d.sys_id)
            d.comments = comments
        }
        return data
    } catch (error) {
        return { error: error.message };
    }
}

async function updateIncident(sysId, data) {
    if (data.comment) {
        return addComment(sysId, data.comment)
    }
    const instanceUrl = getInstanceUrl()
    const apiUrl = `${instanceUrl}/api/now/table/incident/${sysId}`
    try {
        const response = await fetch(apiUrl, {
            method: 'PUT',
            headers: makeStandardHeaders(),
            body: JSON.stringify(data),
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const responseData = await response.json();
        return responseData;
    } catch (error) {
        return { error: error }
    }
}

function isIncident(obj) {
    return isInstanceOfType(obj, 'servicenow/incident')
}

function getSysId(inst) {
    return inst.lookup('sys_id')
}

function pathQueryValue(inst) {
    const p = inst.lookupQueryVal('__path__')
    if (p) {
        return p.split('/')[1]
    }
    return undefined
}

function asIncidentInstance(data, sys_id) {
    return makeInstance('servicenow', 'incident', new Map().set('data', data).set('sys_id', data.sys_id || sys_id))
}

export async function updateInstance(resolver, inst, newAttrs) {
    if (isIncident(inst)) {
        const sys_id = getSysId(inst)
        let r = await updateIncident(sys_id, newAttrs.get('data'))
        return asIncidentInstance(r, sys_id)
    } else {
        throw new Error(`Cannot update instance ${inst}`)
    }
}

export async function queryInstances(resolver, inst, queryAll) {
    if (isIncident(inst)) {
        const sys_id = inst.lookupQueryVal('sys_id')
        let r = []
        if (sys_id) {
            r = await getIncidents(pathQueryValue(inst), queryAll ? 100 : 1)
        } else if (queryAll) {
            r = await getIncidents(undefined, 1)
        } else {
            return []
        }
        if (!(r instanceof Array)) {
            r = [r]
        }
        return r.map(asIncidentInstance)
    } else {
        return []
    }
}

async function handleSubs(resolver) {
    console.log('fetching incidents ...')
    const result = await getIncidents(undefined, 1)
    if (result instanceof Array) {
        for (let i = 0; i < result.length; ++i) {
            const incident = result[i]
	    console.log('processing incident ' + incident.sys_id)
            await resolver.onSubscription(JSON.stringify(incident))
        }
    }
}

export async function subs(resolver) {
    await handleSubs(resolver)
    setInterval(async () => {
        await handleSubs(resolver)
    }, 60000 * 2)
}

export function assignIncident(sys_id, userEmail) {
    console.log(`Incident ${sys_id} assigned to ${userEmail}`)
}
