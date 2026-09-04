import { State } from '../core/state.js';
import { sleep, updateStatus } from '../core/utils.js';

export async function fetchStagePorts() {
    try {
        const res = await fetch('/api/ports');
        const ports = await res.json();
        
        let portList = Array.isArray(ports) ? ports : (ports.ports || []);
        let h = portList.map(p => {
            let val = typeof p === 'object' ? (p.path || p.comName || p.port || p.device) : p;
            return `<option value="${val}">${val}</option>`;
        }).join('');
        
        if (!h) h = '<option value="">No Stage Ports Found</option>';
        document.getElementById('stagePort').innerHTML = h;
        updateStatus("<span style='color:#00ffcc;'>Stage COM ports scanned successfully.</span>");
    } catch (e) {
        updateStatus("<span style='color:red;'>Failed to scan Backend COM ports for Stage.</span>");
    }
}

export async function sendStageCommand(gcode) {
    if (!State.connections.isStageConnected) return;
    const port = document.getElementById('stagePort').value;
    if (!port) {
        updateStatus("<span style='color:red;'>Error: No Stage Port selected.</span>");
        return;
    }
    try {
        const cmdWithNewline = gcode + '\n';
        const res = await fetch(`/api/stage?port=${encodeURIComponent(port)}&cmd=${encodeURIComponent(cmdWithNewline)}`, { method: 'POST' });
        if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    } catch (e) {
        updateStatus(`<span style="color:red;">Stage TX Failed: ${e.message}</span>`);
    }
}

export async function toggleStageConnection() {
    State.connections.isStageConnected = !State.connections.isStageConnected;
    const btn = document.getElementById('stageToggle');
    btn.innerText = State.connections.isStageConnected ? "ON" : "OFF";
    btn.className = State.connections.isStageConnected ? "conn-btn conn-on" : "conn-btn conn-off";
    
    if (State.connections.isStageConnected) {
        updateStatus(`<span style="color:#00ffcc;">Backend Stage Port ACTIVATED.</span>`);
        await sendStageCommand("G21");
        await sendStageCommand("G90");
    } else {
        updateStatus(`<span style="color:orange;">Backend Stage Port DEACTIVATED.</span>`);
    }
}

export function calculateGv() {
    if (State.sensor.previousGauss === null) return 0.000;
    return State.sensor.currentGauss - State.sensor.previousGauss;
}

export function getHardwareLimits() {
    let valL = parseFloat(document.getElementById('hallLimLeft').value);
    let valR = parseFloat(document.getElementById('hallLimRight').value);
    return { limL: isNaN(valL) ? 0 : valL, limR: isNaN(valR) ? 0 : valR };
}

export function updateCoordsDisplay() {
    let Gv = calculateGv();
    let { limL, limR } = getHardwareLimits();
    const isLimit = (limL !== 0 || limR !== 0) && (Gv >= limR || Gv <= limL);
    
    let gaussHtml = isLimit 
        ? `<span class="alert">Gv: ${Gv.toFixed(3)} (LIMIT)</span>` 
        : `<span class="sensor">Gv: ${Gv.toFixed(3)}</span>`;

    document.getElementById('posX').innerText = State.stage.currX.toFixed(3);
    document.getElementById('posY').innerText = State.stage.currY.toFixed(3);
    document.getElementById('posZ').innerText = State.stage.currZ.toFixed(3);
    document.getElementById('gvDisplay').innerHTML = gaussHtml;
}

export async function toggleHardStop(forceState = null, reason = "MANUAL UI OVERRIDE") {
    let nextState = (forceState !== null) ? forceState : !State.stage.isHalted;
    if (State.stage.isHalted === nextState) return; 
    
    State.stage.isHalted = nextState;
    const btn = document.getElementById('btnHardStop');

    if (State.stage.isHalted) {
        btn.innerHTML = "✅ RELEASE HARD STOP ✅";
        btn.classList.add('halted');
        updateStatus(`<span style="color:#ff0000; font-weight:bold; font-size:1.1em;">🛑 TX: [ ! ] FEED HOLD (Reason: ${reason})</span>`);
        await sendStageCommand("!");
        await sendStageCommand("M0");
    } else {
        btn.innerHTML = "🛑 EMERGENCY HARD STOP 🛑";
        btn.classList.remove('halted');
        updateStatus(`<span style="color:#00ff00; font-weight:bold; font-size:1.1em;">✅ TX: [ ~ ] RESUME MOTION NORMAL STATUS</span>`);
        await sendStageCommand("~");
    }
}

export async function setGlobalZero() {
    if (!State.connections.isStageConnected) return updateStatus("<span style='color:red;'>ERROR: Connect Stage Port first.</span>");
    if (State.stage.isHalted) return updateStatus("<span style='color:red;'>ERROR: Firmware is locked.</span>");
    
    State.stage.currX = 0.0; State.stage.currY = 0.0; State.stage.currZ = 0.0;
    State.sensor.previousGauss = State.sensor.currentGauss; 
    
    updateCoordsDisplay();
    updateStatus(`TX GCODE: G92 X0 Y0 Z0 (Global Zero Established)`);
    await sendStageCommand("G92 X0 Y0 Z0");
}

export async function goToAbsoluteZ(targetZ) {
    if (!State.connections.isStageConnected) return updateStatus("ERROR: Stage Port OFF.");
    if (State.stage.isHalted) return updateStatus("<span style='color:red;'>ERROR: Firmware is locked.</span>");

    if (State.session.limits.zPos !== null && targetZ > State.session.limits.zPos) return updateStatus("SW BOUND: Z+");
    if (State.session.limits.zNeg !== null && targetZ < State.session.limits.zNeg) return updateStatus("SW BOUND: Z-");

    let { limL, limR } = getHardwareLimits();
    let Gv = calculateGv();
    
    if (targetZ !== State.stage.currZ) {
        if (Gv >= limR && limR !== 0) return toggleHardStop(true, `Pre-Halt (Gv Limit)`);
        if (Gv <= limL && limL !== 0) return toggleHardStop(true, `Pre-Halt (Gv Limit)`);
    }

    State.sensor.previousGauss = State.sensor.currentGauss;
    State.stage.currZ = targetZ;
    updateCoordsDisplay();

    const feed = getFeedRateStr();
    const gcode = `G1 X${State.stage.currX.toFixed(3)} Y${State.stage.currY.toFixed(3)} Z${State.stage.currZ.toFixed(3)} ${feed}`;
    updateStatus(`TX GCODE: ${gcode} (Absolute Z Move)`);
    await sendStageCommand(gcode);
}

export function getFeedRateStr() {
    const idx = document.getElementById('feedSlider').value;
    return `F${State.stage.feedRates[idx].toString().padStart(3, '0')}`;
}

export function getFeedRateNum() {
    const idx = document.getElementById('feedSlider').value;
    return State.stage.feedRates[idx];
}

export async function moveStage(actualDx, actualDy, actualDz, step) {
    const feed = getFeedRateStr();
    State.sensor.previousGauss = State.sensor.currentGauss;
    State.stage.currX += (actualDx * step); 
    State.stage.currY += (actualDy * step); 
    State.stage.currZ += (actualDz * step);
    
    updateCoordsDisplay();
    const gcode = `G1 X${State.stage.currX.toFixed(3)} Y${State.stage.currY.toFixed(3)} Z${State.stage.currZ.toFixed(3)} ${feed}`;
    updateStatus(`TX GCODE: ${gcode}`);
    await sendStageCommand(gcode);
}

export function handleMove(dx, dy, dz) {
    if (!State.connections.isStageConnected) return updateStatus("ERROR: Stage Port OFF.");
    if (State.stage.isHalted) return updateStatus("<span style='color:red;'>ERROR: Firmware is locked.</span>");

    let actualDx = dx * State.stage.invX;
    let actualDy = dy * State.stage.invY;
    let actualDz = dz * State.stage.invZ;

    let { limL, limR } = getHardwareLimits();
    let Gv = calculateGv();

    if (actualDx !== 0 || actualDy !== 0) {
        if (Gv >= limR && limR !== 0) return toggleHardStop(true, `Pre-Halt (Gv Limit)`);
        if (Gv <= limL && limL !== 0) return toggleHardStop(true, `Pre-Halt (Gv Limit)`);
    }

    const step = State.stage.scales[document.getElementById('scaleSlider').value];
    const nx = State.stage.currX + (actualDx * step);
    const ny = State.stage.currY + (actualDy * step);
    const nz = State.stage.currZ + (actualDz * step);

    if (actualDx > 0 && State.session.limits.xPos !== null && nx > State.session.limits.xPos) return updateStatus("SW BOUND: X+");
    if (actualDx < 0 && State.session.limits.xNeg !== null && nx < State.session.limits.xNeg) return updateStatus("SW BOUND: X-");
    if (actualDy > 0 && State.session.limits.yPos !== null && ny > State.session.limits.yPos) return updateStatus("SW BOUND: Y+");
    if (actualDy < 0 && State.session.limits.yNeg !== null && ny < State.session.limits.yNeg) return updateStatus("SW BOUND: Y-");
    if (actualDz > 0 && State.session.limits.zPos !== null && nz > State.session.limits.zPos) return updateStatus("SW BOUND: Z+");
    if (actualDz < 0 && State.session.limits.zNeg !== null && nz < State.session.limits.zNeg) return updateStatus("SW BOUND: Z-");

    moveStage(actualDx, actualDy, actualDz, step);
}

export async function kickstartStage() {
    if (!State.connections.isStageConnected) return updateStatus("<span style='color:red;'>ERROR: Connect Stage Port first.</span>");
    if (State.stage.isHalted) toggleHardStop(false, "KICKSTART FORCED RELEASE");
    updateStatus("<span style='color:orange;'>KICKSTART: Forcing X -1.0</span>");
    
    State.sensor.previousGauss = State.sensor.currentGauss;
    State.stage.currX -= 1.0; 
    
    updateCoordsDisplay();
    const gcode = `G1 X${State.stage.currX.toFixed(3)} Y${State.stage.currY.toFixed(3)} Z${State.stage.currZ.toFixed(3)} ${getFeedRateStr()}`;
    updateStatus(`TX GCODE: ${gcode}`);
    await sendStageCommand(gcode);
}

export async function moveToCalibrationZ() {
    if (!State.connections.isStageConnected) return false;
    if (State.stage.invX === -1 || State.stage.invY === -1 || State.stage.invZ === -1) return false;

    let targetZ = parseFloat(document.getElementById('calibZTarget').value) || -30.0;
    if (Math.abs(State.stage.currZ - targetZ) < 0.001) return true; 

    updateStatus(`<span style='color:orange;'>Moving Z to ${targetZ.toFixed(1)} for calibration capture...</span>`);

    let dist = Math.abs(targetZ - State.stage.currZ);
    let feedStr = getFeedRateStr(); 
    let feed = getFeedRateNum();

    let moveTimeMs = (dist / feed) * 60000;
    let settleTime = moveTimeMs + 2500;

    State.sensor.previousGauss = State.sensor.currentGauss;
    State.stage.currZ = targetZ;
    updateCoordsDisplay();

    await sendStageCommand(`G1 X${State.stage.currX.toFixed(3)} Y${State.stage.currY.toFixed(3)} Z${State.stage.currZ.toFixed(3)} ${feedStr}`);
    await sleep(settleTime);
    return true;
}

export async function toggleWebSerial() {
    const btn = document.getElementById('lightToggle');
    const statusLabel = document.getElementById('serialStatus');

    if (State.connections.isLightConnected) {
        State.connections.isLightConnected = false;
        try {
            if (State.connections.serialReader) { await State.connections.serialReader.cancel(); State.connections.serialReader = null; }
            if (State.connections.illuminationPort) { await State.connections.illuminationPort.close(); State.connections.illuminationPort = null; }
        } catch(e) {}
        
        btn.innerText = "OFF"; btn.className = "conn-btn conn-off";
        statusLabel.innerText = "Disconnected"; statusLabel.style.color = "red";
        updateStatus("Browser Serial connection closed.");
    } else {
        if (!("serial" in navigator)) { alert("Web Serial API is not supported in this browser."); return; }
        try {
            State.connections.illuminationPort = await navigator.serial.requestPort();
            await State.connections.illuminationPort.open({ baudRate: 9600 });
            State.connections.isLightConnected = true;

            btn.innerText = "ON"; btn.className = "conn-btn conn-on";
            statusLabel.innerText = "Connected Native USB"; statusLabel.style.color = "#00ff00";
            updateStatus("Web Serial Port Opened Successfully!");

            readSerialStream();
        } catch (e) { updateStatus(`<span style="color:red;">Serial Access Denied</span>`); }
    }
}

export async function readSerialStream() {
    const textDecoder = new TextDecoderStream();
    const readableStreamClosed = State.connections.illuminationPort.readable.pipeTo(textDecoder.writable);
    State.connections.serialReader = textDecoder.readable.getReader();
    let buffer = "";

    try {
        while (true) {
            const { value, done } = await State.connections.serialReader.read();
            if (done) break;

            buffer += value;
            let lines = buffer.split('\n'); 
            buffer = lines.pop(); 

            for (let line of lines) {
                line = line.trim();
                if (line !== "") {
                    const match = line.match(/Reading_in_avg_Gauss:\s*(-?\d+(\.\d+)?)/);
                    if (match) {
                        let parsedValue = parseFloat(match[1]);
                        if (State.sensor.previousGauss === null) { State.sensor.previousGauss = parsedValue; }
                        State.sensor.currentGauss = parsedValue;
                        
                        let Gv = calculateGv();
                        let { limL, limR } = getHardwareLimits();

                        if (Gv >= limR || Gv <= limL) {
                            if (!State.stage.isHalted && (limL !== 0 || limR !== 0)) {
                                toggleHardStop(true, `Auto-Interlock Limit Triggered (Gv: ${Gv.toFixed(3)})`);
                            }
                        }
                        updateCoordsDisplay();
                    }
                }
            }
        }
    } catch (error) {
        if (State.connections.isLightConnected) updateStatus(`<span style="color:red;">Serial Error: ${error}</span>`);
    } finally {
        State.connections.serialReader.releaseLock();
    }
}

export async function sendLightData() {
    if (!State.connections.isLightConnected || !State.connections.illuminationPort) return;
    const val = document.getElementById('lightSlider').value;
    const i = Math.round(val * 25.5).toString().padStart(3, '0');
    const cmd = `${i} ${i} ${i}\n`; 
    try {
        const encoder = new TextEncoder();
        const writer = State.connections.illuminationPort.writable.getWriter();
        await writer.write(encoder.encode(cmd));
        writer.releaseLock();
    } catch (e) {}
}

// Z-Axis Scroll Engine Handler
export function handleScrollZ(e) {
    e.preventDefault(); // Prevents the browser page from jumping
    if (!State.connections.isStageConnected) return;
    if (State.stage.isHalted) return updateStatus("<span style='color:red;'>ERROR: Firmware is locked.</span>");

    // Scroll up (negative deltaY) moves Z up (+1). Scroll down moves Z down (-1).
    let direction = e.deltaY < 0 ? 1 : -1;
    let actualDz = direction * State.stage.invZ;

    // Use specific Z-Wheel steps rather than global scale steps
    const step = State.stage.zWheelSteps[document.getElementById('zWheelSlider').value];
    const nz = State.stage.currZ + (actualDz * step);

    // Enforce software boundaries for scrolling
    if (actualDz > 0 && State.session.limits.zPos !== null && nz > State.session.limits.zPos) return updateStatus("SW BOUND: Z+");
    if (actualDz < 0 && State.session.limits.zNeg !== null && nz < State.session.limits.zNeg) return updateStatus("SW BOUND: Z-");

    moveStage(0, 0, actualDz, step);
}