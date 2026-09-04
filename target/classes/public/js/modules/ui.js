import { State } from '../core/state.js';
import { updateStatus } from '../core/utils.js';

// Camera Imports
import { 
    toggleCamera, switchCamera, captureDark, captureBackground, 
    toggleDark, toggleBackground, validateBgMultiplier, 
    applyFilters, toggleCalibration, captureImage 
} from './camera.js';

// Vision Imports
import { toggleObjectAnalysis } from './vision.js';

// Automation Imports
import { saveWaypoint, goToWaypoint, deleteWaypoint, toggleSequence } from './automation.js';

// Hardware Imports
import { 
    fetchStagePorts, toggleStageConnection, toggleHardStop, 
    setGlobalZero, handleMove, goToAbsoluteZ, 
    toggleWebSerial, sendLightData, handleScrollZ
} from './hardware.js';


export function initUI() {
    
    // ==========================================
    // STEP 1: Camera & Stream Controls
    // ==========================================
    document.getElementById('camToggle')?.addEventListener('click', toggleCamera);
    document.getElementById('cameraSelect')?.addEventListener('change', switchCamera);
    document.getElementById('btnCaptureImage')?.addEventListener('click', () => captureImage(null));
    
    // ==========================================
    // STEP 2: GPU Filters & Math Calibrations
    // ==========================================
    document.getElementById('laplaceDenoiseToggle')?.addEventListener('change', applyFilters);
    document.getElementById('laplaceEdgeToggle')?.addEventListener('change', applyFilters);
    
    document.getElementById('applyDarkToggle')?.addEventListener('change', toggleDark);
    document.getElementById('btnCapDark')?.addEventListener('click', captureDark);
    
    document.getElementById('applyBgToggle')?.addEventListener('change', toggleBackground);
    document.getElementById('btnCapFlat')?.addEventListener('click', captureBackground);
    document.getElementById('bgMultiplier')?.addEventListener('input', (e) => validateBgMultiplier(e.target));
    
    document.getElementById('btnCalib')?.addEventListener('click', toggleCalibration);

    // ==========================================
    // STEP 3: Kinematic Sliders & Labels
    // ==========================================
    document.getElementById('scaleSlider')?.addEventListener('input', (e) => {
        const val = State.stage.scales[e.target.value];
        document.getElementById('scaleValue').innerText = "Step: " + val;
    });

    document.getElementById('feedSlider')?.addEventListener('input', (e) => {
        const val = State.stage.feedRates[e.target.value];
        document.getElementById('feedValue').innerText = "F" + val.toString().padStart(3, '0');
    });

    document.getElementById('zWheelSlider')?.addEventListener('input', (e) => {
        const val = State.stage.zWheelSteps[e.target.value];
        document.getElementById('zWheelValue').innerText = val.toFixed(3);
    });

    document.getElementById('lightSlider')?.addEventListener('input', sendLightData);
    document.getElementById('lightSlider')?.addEventListener('change', sendLightData);

    // ==========================================
    // STEP 4: System Hooks & Automation
    // ==========================================
    document.getElementById('lightToggle')?.addEventListener('click', toggleWebSerial);
    document.getElementById('btnScanPorts')?.addEventListener('click', fetchStagePorts);
    document.getElementById('stageToggle')?.addEventListener('click', toggleStageConnection);
    document.getElementById('btnHardStop')?.addEventListener('click', () => toggleHardStop(null, "MANUAL UI OVERRIDE"));
    document.getElementById('btnMoveZero')?.addEventListener('click', setGlobalZero);
    
    document.getElementById('btnGoZ')?.addEventListener('click', () => {
        const zTarget = parseFloat(document.getElementById('zTargetInput').value);
        if (!isNaN(zTarget)) goToAbsoluteZ(zTarget);
    });

    document.querySelectorAll('.move-btn:not(.zero-btn)').forEach(btn => {
        if(btn.hasAttribute('data-dx')) {
            btn.addEventListener('click', () => {
                handleMove(
                    parseFloat(btn.getAttribute('data-dx')),
                    parseFloat(btn.getAttribute('data-dy')),
                    parseFloat(btn.getAttribute('data-dz'))
                );
            });
        }
    });

    document.querySelectorAll('.limit-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!State.connections.isStageConnected) return;
            const key = dot.getAttribute('data-axis');
            if (State.session.limits[key] === null) {
                State.session.limits[key] = (key.startsWith('x')) ? State.stage.currX : (key.startsWith('y') ? State.stage.currY : State.stage.currZ);
                dot.classList.add('active');
            } else {
                State.session.limits[key] = null;
                dot.classList.remove('active');
            }
        });
    });

    // Z-Axis Hover Scroll Logic (Safely intercepts default scrolling)
    document.getElementById('overlayCanvas')?.addEventListener('wheel', handleScrollZ, { passive: false });

    document.getElementById('btnToggleAnalysis')?.addEventListener('click', toggleObjectAnalysis);
    document.getElementById('btnSaveWaypoint')?.addEventListener('click', saveWaypoint);
    document.getElementById('btnGoWaypoint')?.addEventListener('click', goToWaypoint);
    document.getElementById('btnDelWaypoint')?.addEventListener('click', deleteWaypoint);
    document.getElementById('btnSequence')?.addEventListener('click', toggleSequence);

    // Session Management (Native File System API Bridge)
    document.getElementById('btnInitSession')?.addEventListener('click', async () => {
        const user = document.getElementById('userName').value;
        const exp = document.getElementById('expName').value;
        if (!user || !exp) return alert("All fields required.");

        try {
            const baseDirHandle = await window.showDirectoryPicker();
            const folderHandle = await baseDirHandle.getDirectoryHandle(exp, { create: true });
            
            State.session.user = user;
            State.session.experiment = exp;
            State.session.dirHandle = baseDirHandle;
            State.session.expFolderHandle = folderHandle;
            
            document.getElementById('sessionOverlay').style.display = 'none';
            document.getElementById('mainPanel').classList.add('active');
            updateStatus(`<span style="color:#ffcc00;">Session Started: ${exp}</span>`);
        } catch (err) {
            alert("Directory permission required to save files natively.");
        }
    });

    document.getElementById('btnSaveLog')?.addEventListener('click', async () => {
        if (!State.session.expFolderHandle) return updateStatus("<span style='color:red;'>No active session directory.</span>");
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        
        const snapshot = {
            coords: { X: State.stage.currX, Y: State.stage.currY, Z: State.stage.currZ },
            sensor_gauss_raw: State.sensor.currentGauss,
            light: document.getElementById('lightSlider').value,
            calibration: State.calibration.pixelsPerUnit > 0 ? { pxPerUnit: State.calibration.pixelsPerUnit.toFixed(4), unit: State.calibration.activeUnit } : null,
            waypoints: State.automation.waypoints
        };
        try {
            const fileHandle = await State.session.expFolderHandle.getFileHandle(`data_${timestamp}.json`, { create: true });
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(snapshot, null, 2));
            await writable.close();
            updateStatus("<span style='color:#ffaa00;'>Data log saved successfully.</span>");
        } catch (e) {
            updateStatus(`<span style="color:red;">Error saving log: ${e.message}</span>`);
        }
    });

    document.getElementById('btnExit')?.addEventListener('click', () => {
        if(confirm("Shutdown system?")) {
            if(State.connections.videoStream) State.connections.videoStream.getTracks().forEach(track => track.stop());
            if (State.connections.illuminationPort) toggleWebSerial(); 
            
            fetch('/api/exit').then(() => { 
                document.body.innerHTML = "<h1 style='color:#ff4444; font-family:monospace; text-align:center; width:100%; margin-top:20%; font-size:4em;'>SYSTEM OFFLINE</h1>"; 
            });
        }
    });

    // Invert Toggles mapping
    document.getElementById('btnInvX')?.addEventListener('click', () => { State.stage.invX *= -1; document.getElementById('invDotX').classList.toggle('active'); });
    document.getElementById('btnInvY')?.addEventListener('click', () => { State.stage.invY *= -1; document.getElementById('invDotY').classList.toggle('active'); });
    document.getElementById('btnInvZ')?.addEventListener('click', () => { State.stage.invZ *= -1; document.getElementById('invDotZ').classList.toggle('active'); });
}