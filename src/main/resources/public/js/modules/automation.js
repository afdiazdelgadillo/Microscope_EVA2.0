import { State } from '../core/state.js';
import { sleep, updateStatus } from '../core/utils.js';
import { sendStageCommand, updateCoordsDisplay, getFeedRateStr, getFeedRateNum } from './hardware.js';
import { captureImage } from './camera.js';

export function saveWaypoint() {
    const defaultName = `Pos_X${State.stage.currX.toFixed(1)}_Y${State.stage.currY.toFixed(1)}_Z${State.stage.currZ.toFixed(1)}`;
    const wpName = prompt("Name this position:", defaultName);
    if (!wpName) return;
    
    State.automation.waypoints.push({ name: wpName, x: State.stage.currX, y: State.stage.currY, z: State.stage.currZ });
    renderWaypoints();
    updateStatus(`<span style="color:#00ffcc;">Saved position: ${wpName}</span>`);
}

export function renderWaypoints() {
    const list = document.getElementById('waypointList');
    list.innerHTML = "";
    State.automation.waypoints.forEach((wp, index) => {
        let opt = document.createElement('option');
        opt.value = index;
        opt.innerHTML = `${wp.name} [${wp.x.toFixed(2)}, ${wp.y.toFixed(2)}, ${wp.z.toFixed(2)}]`;
        list.appendChild(opt);
    });
    list.scrollTop = list.scrollHeight;
}

export async function goToWaypoint() {
    const list = document.getElementById('waypointList');
    if (list.selectedIndex < 0) return updateStatus("<span style='color:red;'>Select a waypoint from the list first.</span>");
    if (!State.connections.isStageConnected) return updateStatus("<span style='color:red;'>ERROR: Connect Stage Port first.</span>");
    if (State.stage.isHalted) return updateStatus("<span style='color:red;'>ERROR: Firmware is locked.</span>");
    
    let wp = State.automation.waypoints[list.selectedIndex];
    State.sensor.previousGauss = State.sensor.currentGauss;
    
    State.stage.currX = wp.x; 
    State.stage.currY = wp.y; 
    State.stage.currZ = wp.z;
    updateCoordsDisplay();
    
    let feedStr = getFeedRateStr();
    const gcode = `G1 X${State.stage.currX.toFixed(3)} Y${State.stage.currY.toFixed(3)} Z${State.stage.currZ.toFixed(3)} ${feedStr}`;
    
    updateStatus(`TX GCODE: ${gcode} (Moving to Waypoint)`);
    try { await sendStageCommand(gcode); } catch(e) {}
}

export function deleteWaypoint() {
    const list = document.getElementById('waypointList');
    if (list.selectedIndex < 0) return;
    let deleted = State.automation.waypoints.splice(list.selectedIndex, 1)[0];
    renderWaypoints();
    updateStatus(`<span style="color:orange;">Deleted waypoint: ${deleted.name}</span>`);
}

export function parseTimeStr(str) {
    let parts = str.split(':');
    if(parts.length !== 3) return 0;
    let h = parseInt(parts[0])||0;
    let m = parseInt(parts[1])||0;
    let s = parseInt(parts[2])||0;
    return (h * 3600000) + (m * 60000) + (s * 1000);
}

export async function toggleSequence() {
    if (State.automation.sequenceActive) {
        State.automation.sequenceActive = false;
        document.getElementById('btnSequence').innerText = "▶ RUN SEQUENCE";
        document.getElementById('btnSequence').style.background = "#ffaa00";
        updateStatus("<span style='color:orange; font-weight:bold;'>Sequence Aborted by User.</span>");
        return;
    }

    if (State.automation.waypoints.length === 0) return updateStatus("<span style='color:red;'>No waypoints saved to sequence!</span>");
    if (!State.session.experiment) return updateStatus("<span style='color:red;'>Start a session first to save sequence images.</span>");
    if (!State.connections.isStageConnected) return updateStatus("<span style='color:red;'>Connect Stage Port before running macro.</span>");

    let cycles = parseInt(document.getElementById('seqCycles').value) || 1;
    let intervalMs = parseTimeStr(document.getElementById('seqInterval').value);

    State.automation.sequenceActive = true;
    const btn = document.getElementById('btnSequence');
    btn.innerText = "⏹ STOP SEQUENCE";
    btn.style.background = "#ff4444";

    updateStatus(`<span style="color:#00ffcc; font-weight:bold;">SEQUENCE STARTED: ${cycles} Cycles</span>`);

    for (let c = 1; c <= cycles; c++) {
        if (!State.automation.sequenceActive) break;
        updateStatus(`<span style="color:#00ffcc;">--- Executing Cycle ${c} of ${cycles} ---</span>`);

        for (let w = 0; w < State.automation.waypoints.length; w++) {
            if (!State.automation.sequenceActive || State.stage.isHalted) break;
            let wp = State.automation.waypoints[w];

            let dx = wp.x - State.stage.currX; 
            let dy = wp.y - State.stage.currY; 
            let dz = wp.z - State.stage.currZ;
            let dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
            
            let feedStr = getFeedRateStr(); 
            let feed = getFeedRateNum();

            let moveTimeMs = (dist / feed) * 60000;
            let settleTime = moveTimeMs + 2500; 

            State.stage.currX = wp.x; State.stage.currY = wp.y; State.stage.currZ = wp.z;
            updateCoordsDisplay();
            
            let gcode = `G1 X${State.stage.currX.toFixed(3)} Y${State.stage.currY.toFixed(3)} Z${State.stage.currZ.toFixed(3)} ${feedStr}`;
            updateStatus(`[Cycle ${c}] Moving to ${wp.name}... (Waiting ${(settleTime/1000).toFixed(1)}s)`);
            
            await sendStageCommand(gcode);
            await sleep(settleTime);
            
            if (!State.automation.sequenceActive || State.stage.isHalted) break;

            let dateStr = new Date().toISOString().replace(/[:.]/g, "-").split('T');
            let timeStamp = dateStr[0] + "-" + dateStr[1].substring(0,6);
            let safeName = wp.name.replace(/[^a-zA-Z0-9_-]/g, "_"); 
            let fileName = `${timeStamp}_X${wp.x.toFixed(2)}_Y${wp.y.toFixed(2)}_Z${wp.z.toFixed(2)}_${safeName}_Cycle${c}`;
            
            await captureImage(fileName);
            await sleep(500); 
        }

        if (!State.automation.sequenceActive || State.stage.isHalted) break;
        
        if (c < cycles) {
            updateStatus(`<span style="color:orange;">Cycle ${c} Complete. Waiting...</span>`);
            await sleep(intervalMs);
        }
    }

    if (State.automation.sequenceActive) {
        updateStatus("<span style='color:#00ff00; font-weight:bold;'>✅ Macro Sequence Complete!</span>");
        State.automation.sequenceActive = false;
        btn.innerText = "▶ RUN SEQUENCE";
        btn.style.background = "#ffaa00";
    }
}