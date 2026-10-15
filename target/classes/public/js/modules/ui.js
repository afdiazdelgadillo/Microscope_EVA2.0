import { State } from '../core/state.js';
import { updateStatus } from '../core/utils.js';

// Camera Imports
import { 
    toggleCamera, switchCamera, captureDark, captureBackground, 
    toggleDark, toggleBackground, validateBgMultiplier, 
    applyFilters, toggleCalibration, updateCalibrationScale,
    handleOverlayMouseDown, handleOverlayMouseMove, handleOverlayMouseUp,
    handleOverlayClick, captureImage, updateLedStabilizationUI,
    renderRecentImages, openRecentModal, closeRecentModal, stepRecentImage,
    restoreCalibrationFramesFromFolder, addRecentImage
} from './camera.js';

// Vision Imports
import { toggleObjectAnalysis } from './vision.js';

// Automation Imports
import { saveWaypoint, renderWaypoints, goToWaypoint, deleteWaypoint, toggleSequence } from './automation.js';

// Hardware Imports
import { 
    fetchStagePorts, toggleStageConnection, toggleHardStop, 
    setGlobalZero, handleMove, goToAbsoluteZ, kickstartStage,
    toggleWebSerial, sendLightData, handleScrollZ,
    setFeedRate, getFeedRateNum, updateCoordsDisplay
} from './hardware.js';

const SESSION_STORAGE_KEY = 'microscope_v70_session_settings';

export function collectSessionSettings() {
    const lightSliderEl = document.getElementById('lightSlider');
    const sliderVal = parseFloat(lightSliderEl ? lightSliderEl.value : 0) || 0;
    const savedIntensity = sliderVal > 0 ? sliderVal : (State.connections.lightIntensity || 10);

    return {
        timestamp: new Date().toISOString(),
        user: State.session.user || document.getElementById('userName')?.value || "",
        experiment: State.session.experiment || document.getElementById('expName')?.value || "",
        illumination: {
            sliderValue: sliderVal,
            savedIntensity: savedIntensity,
            ledStabilizationTimeMs: State.camera.ledStabilizationTimeMs
        },
        waypoints: State.automation.waypoints.map(wp => ({
            name: wp.name,
            x: Number(wp.x),
            y: Number(wp.y),
            z: Number(wp.z)
        })),
        filters: {
            colorFeed: Boolean(document.getElementById('colorStreamToggle')?.checked),
            denoise: Boolean(document.getElementById('laplaceDenoiseToggle')?.checked),
            edgeMap: Boolean(document.getElementById('laplaceEdgeToggle')?.checked),
            invert: Boolean(document.getElementById('invertToggle')?.checked),
            subNoise: Boolean(document.getElementById('applyDarkToggle')?.checked),
            divFlat: Boolean(document.getElementById('applyBgToggle')?.checked),
            bgMultiplier: parseFloat(document.getElementById('bgMultiplier')?.value) ?? 1.0,
            calibZTarget: parseFloat(document.getElementById('calibZTarget')?.value) ?? -30
        },
        camera: {
            imgFormat: document.getElementById('imgFormat')?.value || 'image/png',
            ledStabilizationTimeMs: State.camera.ledStabilizationTimeMs,
            ledStabilizationHistory: State.camera.ledStabilizationHistory
        },
        stage: {
            coords: { X: State.stage.currX, Y: State.stage.currY, Z: State.stage.currZ },
            feedRate: getFeedRateNum(),
            scaleIndex: parseInt(document.getElementById('scaleSlider')?.value ?? 1, 10),
            zWheelIndex: parseInt(document.getElementById('zWheelSlider')?.value ?? 0, 10),
            zTargetInput: parseFloat(document.getElementById('zTargetInput')?.value) || 0,
            invX: State.stage.invX,
            invY: State.stage.invY,
            invZ: State.stage.invZ,
            limits: { ...State.session.limits },
            hallLimLeft: parseFloat(document.getElementById('hallLimLeft')?.value) || 0,
            hallLimRight: parseFloat(document.getElementById('hallLimRight')?.value) || 0
        },
        sensor_gauss_raw: State.sensor.currentGauss,
        calibration: {
            calibValue: parseFloat(document.getElementById('calibValue')?.value) || 10,
            calibUnit: document.getElementById('calibUnit')?.value || 'um',
            pixelsPerUnit: State.calibration.pixelsPerUnit,
            activeUnit: State.calibration.activeUnit,
            lineStart: { ...State.calibration.lineStart },
            lineEnd: { ...State.calibration.lineEnd }
        },
        macro: {
            seqCycles: parseInt(document.getElementById('seqCycles')?.value, 10) || 1,
            seqInterval: document.getElementById('seqInterval')?.value || '00:00:00'
        }
    };
}

export function applySessionSettings(s) {
    if (!s || typeof s !== 'object') return;

    // 1. Illumination
    if (s.illumination || s.light !== undefined) {
        const savedInt = s.illumination?.savedIntensity ?? parseFloat(s.light) ?? 10;
        if (!isNaN(savedInt) && savedInt > 0) {
            State.connections.lightIntensity = Math.min(10, Math.max(0, savedInt));
        }
        const sliderVal = s.illumination?.sliderValue ?? parseFloat(s.light) ?? 0;
        const lightSlider = document.getElementById('lightSlider');
        if (lightSlider && !isNaN(sliderVal)) {
            lightSlider.value = Math.min(10, Math.max(0, sliderVal));
            sendLightData();
        }
        if (s.illumination?.ledStabilizationTimeMs !== undefined && s.illumination?.ledStabilizationTimeMs !== null) {
            State.camera.ledStabilizationTimeMs = Number(s.illumination.ledStabilizationTimeMs);
            updateLedStabilizationUI(State.camera.ledStabilizationTimeMs);
        }
    }

    // 2. Waypoints
    if (Array.isArray(s.waypoints)) {
        State.automation.waypoints = s.waypoints.map(wp => ({
            name: String(wp.name || 'Pos'),
            x: Number(wp.x) || 0,
            y: Number(wp.y) || 0,
            z: Number(wp.z) || 0
        }));
        renderWaypoints();
    }

    // 3. Stream & Filters (Color Feed, Denoise, Edge Map, Invert, Sub Noise, Div Flat)
    if (s.filters) {
        const colorEl = document.getElementById('colorStreamToggle');
        const denoiseEl = document.getElementById('laplaceDenoiseToggle');
        const edgeEl = document.getElementById('laplaceEdgeToggle');
        const invertEl = document.getElementById('invertToggle');
        const darkEl = document.getElementById('applyDarkToggle');
        const bgEl = document.getElementById('applyBgToggle');
        const multEl = document.getElementById('bgMultiplier');
        const zTargEl = document.getElementById('calibZTarget');

        if (colorEl && s.filters.colorFeed !== undefined) colorEl.checked = Boolean(s.filters.colorFeed);
        if (denoiseEl && s.filters.denoise !== undefined) denoiseEl.checked = Boolean(s.filters.denoise);
        if (edgeEl && s.filters.edgeMap !== undefined) edgeEl.checked = Boolean(s.filters.edgeMap);
        if (invertEl && s.filters.invert !== undefined) invertEl.checked = Boolean(s.filters.invert);
        if (darkEl && s.filters.subNoise !== undefined) darkEl.checked = Boolean(s.filters.subNoise);
        if (bgEl && s.filters.divFlat !== undefined) bgEl.checked = Boolean(s.filters.divFlat);
        if (multEl && s.filters.bgMultiplier !== undefined && !isNaN(s.filters.bgMultiplier)) {
            multEl.value = s.filters.bgMultiplier;
            validateBgMultiplier(multEl);
        }
        if (zTargEl && s.filters.calibZTarget !== undefined && !isNaN(s.filters.calibZTarget)) {
            zTargEl.value = s.filters.calibZTarget;
        }
        applyFilters();
    }

    // 4. Camera Capture Format & LED Stabilization Telemetry
    if (s.camera) {
        if (s.camera.imgFormat) {
            const fmtEl = document.getElementById('imgFormat');
            if (fmtEl) fmtEl.value = s.camera.imgFormat;
        }
        if (s.camera.ledStabilizationTimeMs !== undefined && s.camera.ledStabilizationTimeMs !== null) {
            State.camera.ledStabilizationTimeMs = Number(s.camera.ledStabilizationTimeMs);
            updateLedStabilizationUI(State.camera.ledStabilizationTimeMs);
        }
        if (Array.isArray(s.camera.ledStabilizationHistory)) {
            State.camera.ledStabilizationHistory = s.camera.ledStabilizationHistory;
        }
    }

    // 5. Stage Kinematics & Limits
    if (s.stage) {
        if (s.stage.feedRate !== undefined) {
            setFeedRate(s.stage.feedRate, 'restore');
        }
        if (s.stage.scaleIndex !== undefined) {
            const scaleSlider = document.getElementById('scaleSlider');
            const scaleValEl = document.getElementById('scaleValue');
            const idx = Math.min(State.stage.scales.length - 1, Math.max(0, parseInt(s.stage.scaleIndex, 10) || 0));
            if (scaleSlider) scaleSlider.value = idx;
            if (scaleValEl) scaleValEl.innerText = "Step: " + State.stage.scales[idx];
        }
        if (s.stage.zWheelIndex !== undefined) {
            const zwSlider = document.getElementById('zWheelSlider');
            const zwValEl = document.getElementById('zWheelValue');
            const idx = Math.min(State.stage.zWheelSteps.length - 1, Math.max(0, parseInt(s.stage.zWheelIndex, 10) || 0));
            if (zwSlider) zwSlider.value = idx;
            if (zwValEl) zwValEl.innerText = State.stage.zWheelSteps[idx].toFixed(3);
        }
        if (s.stage.zTargetInput !== undefined && !isNaN(s.stage.zTargetInput)) {
            const zInp = document.getElementById('zTargetInput');
            if (zInp) zInp.value = Number(s.stage.zTargetInput).toFixed(3);
        }
        if (s.stage.invX !== undefined) {
            State.stage.invX = s.stage.invX === -1 ? -1 : 1;
            document.getElementById('invDotX')?.classList.toggle('active', State.stage.invX === -1);
        }
        if (s.stage.invY !== undefined) {
            State.stage.invY = s.stage.invY === -1 ? -1 : 1;
            document.getElementById('invDotY')?.classList.toggle('active', State.stage.invY === -1);
        }
        if (s.stage.invZ !== undefined) {
            State.stage.invZ = s.stage.invZ === -1 ? -1 : 1;
            document.getElementById('invDotZ')?.classList.toggle('active', State.stage.invZ === -1);
        }
        if (s.stage.hallLimLeft !== undefined) {
            const hlL = document.getElementById('hallLimLeft');
            if (hlL) hlL.value = s.stage.hallLimLeft;
        }
        if (s.stage.hallLimRight !== undefined) {
            const hlR = document.getElementById('hallLimRight');
            if (hlR) hlR.value = s.stage.hallLimRight;
        }
        if (s.stage.limits && typeof s.stage.limits === 'object') {
            Object.keys(State.session.limits).forEach(key => {
                const val = s.stage.limits[key];
                State.session.limits[key] = (val !== null && val !== undefined && !isNaN(val)) ? Number(val) : null;
            });
            document.querySelectorAll('.limit-dot').forEach(dot => {
                const key = dot.getAttribute('data-axis');
                dot.classList.toggle('active', State.session.limits[key] !== null);
            });
        }
        if (s.stage.coords) {
            if (typeof s.stage.coords.X === 'number') State.stage.currX = s.stage.coords.X;
            if (typeof s.stage.coords.Y === 'number') State.stage.currY = s.stage.coords.Y;
            if (typeof s.stage.coords.Z === 'number') State.stage.currZ = s.stage.coords.Z;
            updateCoordsDisplay();
        }
    }

    // 6. Calibration
    if (s.calibration) {
        const cValEl = document.getElementById('calibValue');
        const cUnitEl = document.getElementById('calibUnit');
        if (cValEl && s.calibration.calibValue !== undefined) cValEl.value = s.calibration.calibValue;
        const unit = s.calibration.calibUnit || s.calibration.unit || 'um';
        if (cUnitEl) cUnitEl.value = unit;
        State.calibration.activeUnit = s.calibration.activeUnit || unit;
        const ppu = parseFloat(s.calibration.pixelsPerUnit ?? s.calibration.pxPerUnit ?? 0);
        if (!isNaN(ppu) && ppu >= 0) State.calibration.pixelsPerUnit = ppu;
        if (s.calibration.lineStart) State.calibration.lineStart = { ...s.calibration.lineStart };
        if (s.calibration.lineEnd) State.calibration.lineEnd = { ...s.calibration.lineEnd };
    }

    // 7. Macro Loop
    if (s.macro) {
        const cycEl = document.getElementById('seqCycles');
        const intEl = document.getElementById('seqInterval');
        if (cycEl && s.macro.seqCycles !== undefined) cycEl.value = s.macro.seqCycles;
        if (intEl && s.macro.seqInterval !== undefined) intEl.value = s.macro.seqInterval;
    }
}

export async function saveSessionSettings(manualTrigger = false) {
    const snapshot = collectSessionSettings();
    const jsonStr = JSON.stringify(snapshot, null, 2);

    try {
        localStorage.setItem(SESSION_STORAGE_KEY, jsonStr);
    } catch (e) {}

    if (State.session.expFolderHandle) {
        try {
            const settingsHandle = await State.session.expFolderHandle.getFileHandle('session_settings.json', { create: true });
            const writable = await settingsHandle.createWritable();
            await writable.write(jsonStr);
            await writable.close();

            if (manualTrigger) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
                const logHandle = await State.session.expFolderHandle.getFileHandle(`data_${timestamp}.json`, { create: true });
                const logWritable = await logHandle.createWritable();
                await logWritable.write(jsonStr);
                await logWritable.close();

                if (State.session.experiment) {
                    const blob = new Blob([jsonStr], { type: 'application/json' });
                    const fd = new FormData();
                    fd.append('experiment', State.session.experiment);
                    fd.append('filename', 'session_settings.json');
                    fd.append('image', blob, 'session_settings.json');
                    await fetch('/api/save', { method: 'POST', body: fd }).catch(() => {});
                }

                updateStatus("<span style='color:#00ffcc;'>Session settings & data log saved (Illumination, Waypoints, Div Flat, Sub Noise, Color, Feed Rate).</span>");
            }
        } catch (e) {
            if (manualTrigger) {
                updateStatus(`<span style="color:red;">Error saving session file: ${e.message}</span>`);
            }
        }
    } else if (manualTrigger) {
        updateStatus("<span style='color:#ffaa00;'>Session settings saved to browser storage.</span>");
    }
}

export async function loadSessionSettings(folderHandle = null) {
    let loadedFromFolder = false;

    if (folderHandle) {
        try {
            const fh = await folderHandle.getFileHandle('session_settings.json');
            const file = await fh.getFile();
            const text = await file.text();
            const parsed = JSON.parse(text);
            applySessionSettings(parsed);
            loadedFromFolder = true;
            updateStatus("<span style='color:#00ffcc;'>Restored session settings from session_settings.json.</span>");
        } catch (e) {}

        await restoreCalibrationFramesFromFolder(folderHandle);

        // Scan existing captured images in the experiment folder if recentImages is empty
        if (State.camera.recentImages.length === 0 && folderHandle.values) {
            try {
                for await (const entry of folderHandle.values()) {
                    if (entry.kind === 'file') {
                        const lower = entry.name.toLowerCase();
                        const isImage = lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg');
                        const isCalibFrame = lower === 'noise_darkframe_rgb.png' || lower === 'background_flatfield_rgb.png';
                        if (isImage && !isCalibFrame) {
                            const f = await entry.getFile();
                            const url = URL.createObjectURL(f);
                            const t = new Date(f.lastModified).toLocaleTimeString('en-US', { hour12: false });
                            addRecentImage({ name: entry.name, url, time: t });
                        }
                    }
                }
            } catch (e) {}
        }
    }

    if (!loadedFromFolder) {
        try {
            const raw = localStorage.getItem(SESSION_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                applySessionSettings(parsed);
                if (folderHandle) {
                    await saveSessionSettings(false);
                }
            }
        } catch (e) {}
    }
}

export function initUI() {
    
    // ==========================================
    // STEP 1: Camera & Stream Controls
    // ==========================================
    document.getElementById('camToggle')?.addEventListener('click', toggleCamera);
    document.getElementById('cameraSelect')?.addEventListener('change', switchCamera);
    document.getElementById('btnCaptureImage')?.addEventListener('click', async () => {
        await captureImage(null);
        saveSessionSettings(false);
    });
    document.getElementById('imgFormat')?.addEventListener('change', () => saveSessionSettings(false));
    
    // ==========================================
    // STEP 2: GPU Filters & Math Calibrations
    // ==========================================
    document.getElementById('colorStreamToggle')?.addEventListener('change', () => saveSessionSettings(false));
    document.getElementById('invertToggle')?.addEventListener('change', () => saveSessionSettings(false));
    document.getElementById('laplaceDenoiseToggle')?.addEventListener('change', () => {
        applyFilters();
        saveSessionSettings(false);
    });
    document.getElementById('laplaceEdgeToggle')?.addEventListener('change', () => {
        applyFilters();
        saveSessionSettings(false);
    });
    
    document.getElementById('applyDarkToggle')?.addEventListener('change', () => {
        toggleDark();
        saveSessionSettings(false);
    });
    document.getElementById('btnCapDark')?.addEventListener('click', async () => {
        await captureDark();
        saveSessionSettings(false);
    });
    
    document.getElementById('applyBgToggle')?.addEventListener('change', () => {
        toggleBackground();
        saveSessionSettings(false);
    });
    document.getElementById('btnCapFlat')?.addEventListener('click', async () => {
        await captureBackground();
        saveSessionSettings(false);
    });
    document.getElementById('bgMultiplier')?.addEventListener('input', (e) => {
        validateBgMultiplier(e.target);
        saveSessionSettings(false);
    });
    document.getElementById('calibZTarget')?.addEventListener('change', () => saveSessionSettings(false));
    
    document.getElementById('btnCalib')?.addEventListener('click', toggleCalibration);
    document.getElementById('calibValue')?.addEventListener('input', () => {
        updateCalibrationScale();
        saveSessionSettings(false);
    });
    document.getElementById('calibValue')?.addEventListener('change', () => {
        updateCalibrationScale();
        saveSessionSettings(false);
    });
    document.getElementById('calibUnit')?.addEventListener('change', () => {
        updateCalibrationScale();
        saveSessionSettings(false);
    });

    // ==========================================
    // STEP 3: Kinematic Sliders, Feed Input & Labels
    // ==========================================
    document.getElementById('scaleSlider')?.addEventListener('input', (e) => {
        const val = State.stage.scales[e.target.value];
        document.getElementById('scaleValue').innerText = "Step: " + val;
        saveSessionSettings(false);
    });

    document.getElementById('feedSlider')?.addEventListener('input', (e) => {
        const val = State.stage.feedRates[e.target.value];
        setFeedRate(val, 'slider');
        saveSessionSettings(false);
    });

    document.getElementById('feedInput')?.addEventListener('input', (e) => {
        let rawVal = parseInt(e.target.value, 10);
        if (isNaN(rawVal)) return;
        if (rawVal > 1000) {
            rawVal = 1000;
            e.target.value = 1000;
        }
        if (rawVal >= 1) {
            setFeedRate(rawVal, 'typing');
            saveSessionSettings(false);
        }
    });

    document.getElementById('feedInput')?.addEventListener('change', (e) => {
        let rawVal = parseInt(e.target.value, 10);
        if (isNaN(rawVal) || rawVal < 1) rawVal = 1;
        if (rawVal > 1000) rawVal = 1000;
        setFeedRate(rawVal, 'input');
        saveSessionSettings(false);
    });

    document.getElementById('zWheelSlider')?.addEventListener('input', (e) => {
        const val = State.stage.zWheelSteps[e.target.value];
        document.getElementById('zWheelValue').innerText = val.toFixed(3);
        saveSessionSettings(false);
    });

    document.getElementById('lightSlider')?.addEventListener('input', () => {
        sendLightData();
        saveSessionSettings(false);
    });
    document.getElementById('lightSlider')?.addEventListener('change', () => {
        sendLightData();
        saveSessionSettings(false);
    });

    document.getElementById('hallLimLeft')?.addEventListener('change', () => saveSessionSettings(false));
    document.getElementById('hallLimRight')?.addEventListener('change', () => saveSessionSettings(false));
    document.getElementById('zTargetInput')?.addEventListener('change', () => saveSessionSettings(false));
    document.getElementById('seqCycles')?.addEventListener('change', () => saveSessionSettings(false));
    document.getElementById('seqInterval')?.addEventListener('change', () => saveSessionSettings(false));

    // ==========================================
    // STEP 4: System Hooks & Automation
    // ==========================================
    document.getElementById('lightToggle')?.addEventListener('click', toggleWebSerial);
    document.getElementById('btnScanPorts')?.addEventListener('click', fetchStagePorts);
    document.getElementById('stageToggle')?.addEventListener('click', toggleStageConnection);
    document.getElementById('btnHardStop')?.addEventListener('click', () => toggleHardStop(null, "MANUAL UI OVERRIDE"));
    document.getElementById('btnMoveZero')?.addEventListener('click', setGlobalZero);
    document.getElementById('posDisplayContainer')?.addEventListener('dblclick', kickstartStage);
    
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
            saveSessionSettings(false);
        });
    });

    // Interactive Overlay Canvas: Calibration Line Drawing, Click-to-Center Navigation, and Z-Axis Scroll
    const overlayCanvas = document.getElementById('overlayCanvas');
    overlayCanvas?.addEventListener('mousedown', handleOverlayMouseDown);
    overlayCanvas?.addEventListener('mousemove', handleOverlayMouseMove);
    overlayCanvas?.addEventListener('mouseup', (e) => {
        handleOverlayMouseUp(e);
        saveSessionSettings(false);
    });
    overlayCanvas?.addEventListener('click', handleOverlayClick);
    overlayCanvas?.addEventListener('wheel', handleScrollZ, { passive: false });

    document.getElementById('btnToggleAnalysis')?.addEventListener('click', toggleObjectAnalysis);
    document.getElementById('btnSaveWaypoint')?.addEventListener('click', () => {
        saveWaypoint();
        saveSessionSettings(false);
    });
    document.getElementById('btnGoWaypoint')?.addEventListener('click', goToWaypoint);
    document.getElementById('btnDelWaypoint')?.addEventListener('click', () => {
        deleteWaypoint();
        saveSessionSettings(false);
    });
    document.getElementById('btnSequence')?.addEventListener('click', async () => {
        await toggleSequence();
        saveSessionSettings(false);
    });

    // Recent Images Gallery & Magnified Modal Controls
    document.getElementById('btnMagnifyRecent')?.addEventListener('click', () => openRecentModal(null));
    document.getElementById('btnCloseRecentModal')?.addEventListener('click', closeRecentModal);
    document.getElementById('btnRecentPrev')?.addEventListener('click', () => stepRecentImage(-1));
    document.getElementById('btnRecentNext')?.addEventListener('click', () => stepRecentImage(1));

    window.addEventListener('keydown', (e) => {
        if (!State.camera.isRecentModalOpen) return;
        if (e.key === 'Escape') closeRecentModal();
        else if (e.key === 'ArrowLeft') stepRecentImage(-1);
        else if (e.key === 'ArrowRight') stepRecentImage(1);
    });

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

            await loadSessionSettings(folderHandle);
        } catch (err) {
            alert("Directory permission required to save files natively.");
        }
    });

    document.getElementById('btnSaveLog')?.addEventListener('click', async () => {
        await saveSessionSettings(true);
    });

    document.getElementById('btnExit')?.addEventListener('click', async () => {
        if(confirm("Shutdown system?")) {
            await saveSessionSettings(false);
            if(State.connections.videoStream) State.connections.videoStream.getTracks().forEach(track => track.stop());
            if (State.connections.illuminationPort) toggleWebSerial(); 
            
            fetch('/api/exit').then(() => { 
                document.body.innerHTML = "<h1 style='color:#ff4444; font-family:monospace; text-align:center; width:100%; margin-top:20%; font-size:4em;'>SYSTEM OFFLINE</h1>"; 
            });
        }
    });

    // Invert Toggles mapping
    document.getElementById('btnInvX')?.addEventListener('click', () => {
        State.stage.invX *= -1;
        document.getElementById('invDotX').classList.toggle('active');
        saveSessionSettings(false);
    });
    document.getElementById('btnInvY')?.addEventListener('click', () => {
        State.stage.invY *= -1;
        document.getElementById('invDotY').classList.toggle('active');
        saveSessionSettings(false);
    });
    document.getElementById('btnInvZ')?.addEventListener('click', () => {
        State.stage.invZ *= -1;
        document.getElementById('invDotZ').classList.toggle('active');
        saveSessionSettings(false);
    });
}