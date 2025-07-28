import { encodeForBasicAuth } from '../node_modules/agentlang/out/utils/http.js'
import { makeInstance, isInstanceOfType } from "../node_modules/agentlang/out/runtime/module.js"

const instanceUrl = process.env['SERVICENOW_URL']
const username = process.env['SERVICENOW_USERNAME']
const password = process.env['SERVICENOW_PASSWORD']
const authorizationHeader = `Basic ${encodeForBasicAuth(username, password)}`

const standardHeaders = {
    'Authorization': authorizationHeader,
    'Content-Type': 'application/json' // Add other headers as needed
}

async function getIncidents(sysId, count) {
    const apiUrl = sysId ?
        `${instanceUrl}/api/now/table/incident/${sysId}` :
        `${instanceUrl}/api/now/table/incident?sysparm_limit=${count}&sysparm_query=active=true^ORDERBYDESCsys_updated_on`;
    try {
        const response = await fetch(apiUrl, {
            method: 'GET',
            headers: standardHeaders
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status} ${response.text} ${response.statusText}`);
        }

        const data = await response.json();
        return data.result
    } catch (error) {
        return { error: error.message };
    }
}

async function updateIncident(sysId, data) {
    const apiUrl = `${instanceUrl}/api/now/table/incident/${sysId}`
    try {
        const response = await fetch(apiUrl, {
            method: 'PUT',
            headers: standardHeaders,
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
        if (sys_id) {
            let r = await getIncidents(pathQueryValue(inst), queryAll ? 100 : 1)
            if (!(r instanceof Array)) {
                r = [r]
            }
            return r.map(asIncidentInstance)
        } else {
            return []
        }
    } else {
        return []
    }
}

async function handleSubs(resolver) {
    const result = await getIncidents(undefined, 1)
    if (result instanceof Array) {
        for (let i = 0; i < result.length; ++i) {
            const incident = result[i]
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
