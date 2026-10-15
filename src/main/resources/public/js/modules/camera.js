import { State } from '../core/state.js';
import { sleep, updateStatus } from '../core/utils.js';
import { analyzeFrame } from './vision.js';
import { 
    moveToCalibrationZ, moveStage, getHardwareLimits, 
    calculateGv, toggleHardStop, turnOnLight, turnOffLight 
} from './hardware.js';

export async function populateCameras() {
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        const select = document.getElementById('cameraSelect');
        const currentVal = select.value;
        
        select.innerHTML = '';
        if (videoDevices.length === 0) {
            select.innerHTML = '<option value="">No cameras found</option>';
            return;
        }
        videoDevices.forEach((device, index) => {
            const option = document.createElement('option');
            option.value = device.deviceId;
            option.text = device.label || `Camera ${index + 1}`;
            select.appendChild(option);
        });
        
        if (currentVal && Array.from(select.options).some(opt => opt.value === currentVal)) {
            select.value = currentVal;
        }
    } catch (err) { console.error("Error enumerating devices:", err); }
}

export const DERIVATIVE_DT_MS = 10; // Fixed 10 ms time difference for dI/dt calculation

/**
 * Extracts total frame intensity I(t) = Σ (b * hist[b]), mean intensity,
 * pixel count N = Σ hist[b], and min/max intensity directly from the
 * already-calculated 256-bin histogram array.
 */
export function calculateFromHistogram(histArray) {
    if (!histArray || histArray.length < 256) {
        return { sumIntensity: 0, pixelCount: 0, minVal: 0, maxVal: 0, meanIntensity: 0 };
    }
    let sumIntensity = 0;
    let pixelCount = 0;
    let minVal = 255;
    let maxVal = 0;

    for (let b = 0; b < 256; b++) {
        const count = histArray[b];
        if (count > 0) {
            if (b < minVal) minVal = b;
            if (b > maxVal) maxVal = b;
            sumIntensity += b * count;
            pixelCount += count;
        }
    }
    if (pixelCount === 0) minVal = 0;
    const meanIntensity = pixelCount > 0 ? (sumIntensity / pixelCount) : 0;
    return { sumIntensity, pixelCount, minVal, maxVal, meanIntensity };
}

/**
 * Computes the normalized L1 histogram shift ratio in [0, 1] between two 256-bin histograms.
 * Represents the fraction of pixels that moved between intensity bins.
 */
function calculateHistogramShiftRatio(histA, histB, totalPixels) {
    if (!histA || !histB || totalPixels <= 0) return 0;
    let absDiffSum = 0;
    for (let b = 0; b < 256; b++) {
        absDiffSum += Math.abs(histA[b] - histB[b]);
    }
    return absDiffSum / (2 * totalPixels);
}

function startHistogramDerivativeLoop() {
    stopHistogramDerivativeLoop();
    State.camera.derivativeIntervalId = setInterval(sampleHistogramDerivative10ms, DERIVATIVE_DT_MS);
}

function stopHistogramDerivativeLoop() {
    if (State.camera.derivativeIntervalId !== null) {
        clearInterval(State.camera.derivativeIntervalId);
        State.camera.derivativeIntervalId = null;
    }
}

/**
 * Performs the time derivative dI/dt with a fixed time difference Δt = 10 ms
 * using the intensity sum I(t) = Σ (b * hist[b]) from the calculated histogram.
 */
function sampleHistogramDerivative10ms() {
    if (!State.camera.isProcessingStream) return;

    const now = performance.now();
    // Ensure the histogram is freshly computed from the live video feed at 10 ms resolution
    if (
        State.camera.isStabilizingLed ||
        !State.camera.currentHistogram ||
        State.camera.lastHistogramUpdateMs === null ||
        (now - State.camera.lastHistogramUpdateMs) >= (DERIVATIVE_DT_MS - 2)
    ) {
        updateFrameAndHistogram();
    }

    const hist = State.camera.currentHistogram;
    if (!hist) return;

    // Get intensity data strictly from the already-calculated histogram
    const { sumIntensity, pixelCount, meanIntensity } = calculateFromHistogram(hist);
    const dt = DERIVATIVE_DT_MS; // 10 ms time difference

    let dIdt = 0;
    let dMeandt = 0;
    if (State.camera.prevFrameIntensitySum !== null && State.camera.prevFrameMeanIntensity !== null) {
        dIdt = (sumIntensity - State.camera.prevFrameIntensitySum) / dt;
        dMeandt = (meanIntensity - State.camera.prevFrameMeanIntensity) / dt;
    }

    State.camera.prevFrameIntensitySum = sumIntensity;
    State.camera.prevFrameMeanIntensity = meanIntensity;
    State.camera.frameIntensitySum = sumIntensity;
    State.camera.frameMeanIntensity = meanIntensity;
    State.camera.pixelCount = pixelCount;
    State.camera.frameTimestamp = now;
    State.camera.intensityDerivative = dIdt;
    State.camera.meanIntensityDerivative = dMeandt;

    const sumEl = document.getElementById('intensitySumVal');
    const derivEl = document.getElementById('intensityDerivVal');
    if (sumEl) sumEl.textContent = `ΣI: ${sumIntensity.toLocaleString()}`;
    if (derivEl) derivEl.textContent = `dI/dt: ${Math.round(dIdt).toLocaleString()}/ms`;

    if (typeof State.camera.onFrameIntensitySample === 'function') {
        try {
            State.camera.onFrameIntensitySample({
                frameCount: State.camera.frameCount,
                timestamp: now,
                dt: dt,
                sumIntensity: sumIntensity,
                meanIntensity: meanIntensity,
                pixelCount: pixelCount,
                dIdt: dIdt,
                dMeandt: dMeandt,
                histogram: hist
            });
        } catch (err) {}
    }
}

export async function toggleCamera() {
    const btn = document.getElementById('camToggle');
    const cameraSelect = document.getElementById('cameraSelect');
    const rawVideo = document.getElementById('rawVideo');
    const cameraFeedCanvas = document.getElementById('cameraFeed');
    const overlayCanvas = document.getElementById('overlayCanvas');
    
    if (State.connections.videoStream) {
        stopHistogramDerivativeLoop();
        State.connections.videoStream.getTracks().forEach(track => track.stop());
        State.connections.videoStream = null; 
        rawVideo.srcObject = null;
        State.camera.isProcessingStream = false;
        btn.innerText = "Start Camera"; 
        btn.classList.remove('stop');
        
        const canvas = document.getElementById('intensityBar');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Clear the histogram and intensity telemetry as well
        const histCanvas = document.getElementById('histogramCanvas');
        if(histCanvas) histCanvas.getContext('2d').clearRect(0, 0, histCanvas.width, histCanvas.height);
        State.camera.currentHistogram = null;
        State.camera.lastHistogramUpdateMs = null;
        State.camera.prevFrameIntensitySum = null;
        State.camera.prevFrameMeanIntensity = null;
        State.camera.frameTimestamp = null;
        State.camera.frameIntensitySum = 0;
        State.camera.frameMeanIntensity = 0;
        State.camera.intensityDerivative = 0;
        State.camera.meanIntensityDerivative = 0;
        const sumEl = document.getElementById('intensitySumVal');
        const derivEl = document.getElementById('intensityDerivVal');
        if (sumEl) sumEl.textContent = "ΣI: 0";
        if (derivEl) derivEl.textContent = "dI/dt: 0/ms";

    } else {
        try {
            const selectedDeviceId = cameraSelect.value;
            const constraints = { video: { width: { ideal: 1920 } } };
            if (selectedDeviceId) constraints.video.deviceId = { exact: selectedDeviceId };
            
            State.connections.videoStream = await navigator.mediaDevices.getUserMedia(constraints);
            rawVideo.srcObject = State.connections.videoStream;
            btn.innerText = "Stop Camera"; 
            btn.classList.add('stop');
            
            if (cameraSelect.options.length > 0 && cameraSelect.options[0].text.startsWith("Camera ")) {
                populateCameras();
            }

            rawVideo.onloadedmetadata = () => {
                rawVideo.play();
                cameraFeedCanvas.width = 1280; 
                cameraFeedCanvas.height = 720;
                overlayCanvas.width = 1280;
                overlayCanvas.height = 720;
                State.camera.isProcessingStream = true;
                processFrameRGB();
                startHistogramDerivativeLoop();
            };
        } catch (err) { alert("Camera access denied or error: " + err); }
    }
}

export async function switchCamera() {
    if (State.connections.videoStream) {
        await toggleCamera();
        setTimeout(toggleCamera, 100); 
    }
}

export function drawIntensityBar(min, max, mean) {
    const canvas = document.getElementById('intensityBar');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const pT = 20, pB = 20, w = 12, x = 16;
    const h = canvas.height - pT - pB;

    let grad = ctx.createLinearGradient(0, pT, 0, pT + h);
    grad.addColorStop(0, '#ffffff'); grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad; ctx.fillRect(x, pT, w, h);
    ctx.strokeStyle = '#444'; ctx.strokeRect(x, pT, w, h);

    const mapY = (val) => pT + h - (val / 255.0) * h;
    const drawArrow = (y, color, isMean) => {
        ctx.fillStyle = color; ctx.beginPath();
        if (isMean) { 
            ctx.moveTo(x + w + 2, y); ctx.lineTo(x + w + 10, y - 5); ctx.lineTo(x + w + 10, y + 5);
        } else { 
            ctx.moveTo(x - 2, y); ctx.lineTo(x - 10, y - 5); ctx.lineTo(x - 10, y + 5);
        }
        ctx.fill();
    };

    drawArrow(mapY(max), '#ff0000', false); 
    drawArrow(mapY(min), '#ff0000', false); 
    drawArrow(mapY(mean), '#0088ff', true); 

    // 1.4x Scaled Canvas Font
    ctx.fillStyle = '#888'; ctx.font = '13px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('255', x - 2, pT + 4); ctx.fillText('0', x - 2, pT + h + 4);
    // Note: The main 'INTENSITY' label is now handled strictly in the HTML structure.
}

// Render Real-time Distribution Histogram
export function drawHistogram(histArray) {
    const canvas = document.getElementById('histogramCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);

    let max = 1; // Prevent division by zero
    for (let i = 0; i < 256; i++) {
        if (histArray[i] > max) max = histArray[i];
    }

    ctx.fillStyle = 'rgba(0, 255, 204, 0.7)';
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < 256; i++) {
        let valH = (histArray[i] / max) * h;
        ctx.lineTo(i * (w / 256), h - valH);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fill();
}

export function updateFrameAndHistogram() {
    if (!State.camera.isProcessingStream) return null;

    const rawVideo = document.getElementById('rawVideo');
    const cameraFeedCanvas = document.getElementById('cameraFeed');
    if (!rawVideo || !cameraFeedCanvas || !cameraFeedCanvas.width) return null;
    const displayCtx = cameraFeedCanvas.getContext('2d', { willReadFrequently: true });
    
    let w = cameraFeedCanvas.width;
    let h = cameraFeedCanvas.height;

    displayCtx.drawImage(rawVideo, 0, 0, w, h);
    let imgData = displayCtx.getImageData(0, 0, w, h);
    let data = imgData.data;
    let len = w * h;
    
    let gray = new Uint8Array(len); 
    let hist = new Int32Array(256); // Allocate Histogram Array

    if (State.camera.captureNextFrameAsDark || State.camera.captureNextFrameAsBackground) {
        if (State.camera.captureNextFrameAsDark) {
            State.camera.darkFrameRGB = new Uint8Array(data); 
            State.camera.captureNextFrameAsDark = false;
            
            const bgCanvas = document.createElement('canvas'); bgCanvas.width = w; bgCanvas.height = h;
            const bgCtx = bgCanvas.getContext('2d'); const bgImgData = bgCtx.createImageData(w, h);
            bgImgData.data.set(State.camera.darkFrameRGB); bgCtx.putImageData(bgImgData, 0, 0);
            
            bgCanvas.toBlob(async (blob) => {
                if (State.session.expFolderHandle && blob) {
                    try {
                        const fh = await State.session.expFolderHandle.getFileHandle("noise_darkframe_rgb.png", { create: true });
                        const wr = await fh.createWritable();
                        await wr.write(blob);
                        await wr.close();
                    } catch (e) {}
                }
                if (State.session.experiment) {
                    let fd = new FormData();
                    fd.append("experiment", State.session.experiment);
                    fd.append("filename", "noise_darkframe_rgb.png");
                    fd.append("image", blob, "noise_darkframe_rgb.png");
                    await fetch('/api/save', { method: 'POST', body: fd });
                    updateStatus("<span style='color:#00ffcc;'>Dark frame saved.</span>");
                }
            });
        }

        if (State.camera.captureNextFrameAsBackground) {
            State.camera.backgroundFrameRGB = new Uint8Array(data); 
            State.camera.captureNextFrameAsBackground = false;
            
            const bgCanvas = document.createElement('canvas'); bgCanvas.width = w; bgCanvas.height = h;
            const bgCtx = bgCanvas.getContext('2d'); const bgImgData = bgCtx.createImageData(w, h);
            bgImgData.data.set(State.camera.backgroundFrameRGB); bgCtx.putImageData(bgImgData, 0, 0);

            bgCanvas.toBlob(async (blob) => {
                if (State.session.expFolderHandle && blob) {
                    try {
                        const fh = await State.session.expFolderHandle.getFileHandle("background_flatfield_rgb.png", { create: true });
                        const wr = await fh.createWritable();
                        await wr.write(blob);
                        await wr.close();
                    } catch (e) {}
                }
                if (State.session.experiment) {
                    let fd = new FormData();
                    fd.append("experiment", State.session.experiment);
                    fd.append("filename", "background_flatfield_rgb.png");
                    fd.append("image", blob, "background_flatfield_rgb.png");
                    await fetch('/api/save', { method: 'POST', body: fd });
                    updateStatus("<span style='color:#00ffcc;'>Flat-field frame saved.</span>");
                }
            });
        }
    }

    let applyDark = State.camera.darkFrameRGB && document.getElementById('applyDarkToggle').checked;
    let applyFlat = State.camera.backgroundFrameRGB && document.getElementById('applyBgToggle').checked;
    let bgMult = parseFloat(document.getElementById('bgMultiplier').value) || 1.0;
    let invert = document.getElementById('invertToggle').checked;
    let isColorFeed = document.getElementById('colorStreamToggle').checked;

    for (let i = 0; i < len; i++) {
        let off = i * 4;
        let r = data[off]; let g = data[off+1]; let b = data[off+2];

        if (applyDark) {
            r = Math.max(0, r - State.camera.darkFrameRGB[off]);
            g = Math.max(0, g - State.camera.darkFrameRGB[off+1]);
            b = Math.max(0, b - State.camera.darkFrameRGB[off+2]);
        }

        if (applyFlat) {
            let bgR = State.camera.backgroundFrameRGB[off];
            let bgG = State.camera.backgroundFrameRGB[off+1];
            let bgB = State.camera.backgroundFrameRGB[off+2];

            if (applyDark) {
                bgR = Math.max(0, bgR - State.camera.darkFrameRGB[off]);
                bgG = Math.max(0, bgG - State.camera.darkFrameRGB[off+1]);
                bgB = Math.max(0, bgB - State.camera.darkFrameRGB[off+2]);
            }

            bgR = Math.max(1, bgR); bgG = Math.max(1, bgG); bgB = Math.max(1, bgB);
            
            let divR = r / (bgR / 255.0); let divG = g / (bgG / 255.0); let divB = b / (bgB / 255.0);
            
            r = r + (divR - r) * bgMult; g = g + (divG - g) * bgMult; b = b + (divB - b) * bgMult;
            r = Math.min(255, Math.max(0, r)); g = Math.min(255, Math.max(0, g)); b = Math.min(255, Math.max(0, b));
        }

        if (invert) { r = 255 - r; g = 255 - g; b = 255 - b; }

        let lum = 0.299 * r + 0.587 * g + 0.114 * b;
        
        // Populate Luminance dependencies safely mapped to array boundaries
        let lumInt = Math.floor(lum);
        if (lumInt < 0) lumInt = 0;
        if (lumInt > 255) lumInt = 255;
        
        gray[i] = lumInt;
        hist[lumInt]++; 

        if (isColorFeed) { data[off] = r; data[off+1] = g; data[off+2] = b; } 
        else { data[off] = lumInt; data[off+1] = lumInt; data[off+2] = lumInt; }
    }

    // Store the calculated histogram and extract intensity statistics directly from it
    const { sumIntensity, pixelCount, minVal, maxVal, meanIntensity } = calculateFromHistogram(hist);
    State.camera.currentHistogram = hist;
    State.camera.lastHistogramUpdateMs = performance.now();
    State.camera.frameCount = (State.camera.frameCount || 0) + 1;
    State.camera.pixelCount = pixelCount;
    State.camera.frameIntensitySum = sumIntensity;
    State.camera.frameMeanIntensity = meanIntensity;

    if (State.analysis.isObjectAnalysisActive) { analyzeFrame(gray, w, h); }
    
    drawOverlay();
    drawIntensityBar(minVal, maxVal, meanIntensity);
    drawHistogram(hist); // Deploy Histogram Frame

    if (State.analysis.isObjectAnalysisActive && State.analysis.currentObjects.length > 0) {
        State.analysis.currentObjects.forEach(obj => {
            for(let i=0; i<obj.edges.length; i++) {
                let eIdx = obj.edges[i] * 4;
                data[eIdx] = 0; data[eIdx+1] = 255; data[eIdx+2] = 0; 
            }
        });
    }

    displayCtx.putImageData(imgData, 0, 0);
    return hist;
}

export function processFrameRGB() {
    if (!State.camera.isProcessingStream) return;
    updateFrameAndHistogram();
    requestAnimationFrame(processFrameRGB);
}

export function drawOverlay() {
    const overlayCanvas = document.getElementById('overlayCanvas');
    const ctx = overlayCanvas.getContext('2d');
    ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    
    if (State.calibration.pixelsPerUnit > 0 && !State.calibration.isCalibMode) {
        let cx = overlayCanvas.width/2; let cy = overlayCanvas.height/2;
        ctx.strokeStyle = "rgba(0, 255, 204, 0.4)"; ctx.lineWidth = 1;
        ctx.beginPath(); 
        ctx.moveTo(cx-10, cy); ctx.lineTo(cx+10, cy);
        ctx.moveTo(cx, cy-10); ctx.lineTo(cx, cy+10);
        ctx.stroke();
    }

    if (State.calibration.isDrawingLine || (State.calibration.pixelsPerUnit > 0 && State.calibration.isCalibMode)) {
        ctx.strokeStyle = "#00ffcc"; ctx.lineWidth = 3;
        ctx.beginPath(); 
        ctx.moveTo(State.calibration.lineStart.x, State.calibration.lineStart.y); 
        ctx.lineTo(State.calibration.lineEnd.x, State.calibration.lineEnd.y); 
        ctx.stroke();
        
        if (State.calibration.isDrawingLine) {
            let dist = Math.sqrt(Math.pow(State.calibration.lineEnd.x - State.calibration.lineStart.x, 2) + Math.pow(State.calibration.lineEnd.y - State.calibration.lineStart.y, 2));
            ctx.fillStyle = "#fff"; ctx.font = "bold 34px Arial"; // 1.4x Scaled
            ctx.fillText(`${dist.toFixed(1)} px`, State.calibration.lineEnd.x + 15, State.calibration.lineEnd.y - 15);
        }
    }
    
    if (State.calibration.pixelsPerUnit > 0 && !State.calibration.isDrawingLine) renderScaleBar(ctx, overlayCanvas.width, overlayCanvas.height);

    if (State.analysis.isObjectAnalysisActive && State.analysis.currentObjects.length > 0) {
        let scaleSq = (State.calibration.pixelsPerUnit > 0) ? (State.calibration.pixelsPerUnit * State.calibration.pixelsPerUnit) : 1;
        let scaleLin = (State.calibration.pixelsPerUnit > 0) ? State.calibration.pixelsPerUnit : 1;

        State.analysis.currentObjects.forEach(obj => {
            ctx.strokeStyle = "#ff0000"; ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(obj.cx - 3, obj.cy); ctx.lineTo(obj.cx + 3, obj.cy);
            ctx.moveTo(obj.cx, obj.cy - 3); ctx.lineTo(obj.cx, obj.cy + 3);
            ctx.stroke();

            ctx.font = "bold 15px Arial"; ctx.textAlign = "center"; // 1.4x Scaled
            let a = (obj.area / scaleSq).toFixed(1);
            let p = (obj.perimeter / scaleLin).toFixed(1);
            
            ctx.fillStyle = "yellow"; ctx.fillText(`A:${a}`, obj.cx, obj.cy - 6);
            ctx.fillStyle = "#00ff00"; ctx.fillText(`P:${p}`, obj.cx, obj.cy + 15);
        });
    }
}

export function renderScaleBar(ctx, w, h) {
    let barPx = 150; 
    let realVal = barPx / State.calibration.pixelsPerUnit;
    
    ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
    ctx.fillRect(w - 220, h - 80, 200, 60);
    
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(w - 195, h - 45); ctx.lineTo(w - 195 + barPx, h - 45);
    ctx.moveTo(w - 195, h - 55); ctx.lineTo(w - 195, h - 35);
    ctx.moveTo(w - 195 + barPx, h - 55); ctx.lineTo(w - 195 + barPx, h - 35);
    ctx.stroke();
    
    ctx.fillStyle = "#ffffff"; ctx.font = "bold 34px Arial"; ctx.textAlign = "center"; // 1.4x Scaled
    ctx.fillText(`${realVal.toFixed(2)} ${State.calibration.activeUnit}`, w - 195 + (barPx/2), h - 60);
}

export async function captureDark() {
    if (!State.connections.videoStream) return updateStatus("<span style='color:red;'>Camera not running! Start the camera first.</span>");
    if (confirm(`Capturing Black Noise (Dark Frame).\nEnsure illumination is OFF.`)) {
        State.camera.captureNextFrameAsDark = true;
        document.getElementById('applyDarkToggle').checked = true;
        updateStatus("<span style='color:orange;'>Capturing Black Noise Frame...</span>");
    } else {
        if (!State.camera.darkFrameRGB) document.getElementById('applyDarkToggle').checked = false;
    }
}

export async function captureBackground() {
    if (!State.connections.videoStream) return updateStatus("<span style='color:red;'>Camera not running! Start the camera first.</span>");
    let targetZ = parseFloat(document.getElementById('calibZTarget').value) || -30.0;
    if (confirm(`Capturing Flat-Field (Background).\nMicroscope will move to Z = ${targetZ}.\nClick OK when ready.`)) {
        let success = await moveToCalibrationZ();
        if (!success) return;
        State.camera.captureNextFrameAsBackground = true;
        document.getElementById('applyBgToggle').checked = true;
        updateStatus("<span style='color:orange;'>Capturing Flat-Field Frame...</span>");
    } else {
        if (!State.camera.backgroundFrameRGB) document.getElementById('applyBgToggle').checked = false;
    }
}

export function toggleDark() {
    const toggle = document.getElementById('applyDarkToggle');
    if (toggle.checked) {
        if (!State.camera.darkFrameRGB) captureDark();
        else updateStatus("<span style='color:#00ffcc;'>Black Noise Subtraction applied.</span>");
    } else updateStatus("<span style='color:orange;'>Black Noise Subtraction released.</span>");
}

export function toggleBackground() {
    const toggle = document.getElementById('applyBgToggle');
    if (toggle.checked) {
        if (!State.camera.backgroundFrameRGB) captureBackground();
        else updateStatus("<span style='color:#00ffcc;'>Flat-Field Correction applied.</span>");
    } else updateStatus("<span style='color:orange;'>Flat-Field Correction released.</span>");
}

export function validateBgMultiplier(el) {
    let val = parseFloat(el.value);
    if (isNaN(val)) return;
    if (val > 1) el.value = 1;
    if (val < 0) el.value = 0;
}

export function applyFilters() {
    const video = document.getElementById('cameraFeed');
    const edge = document.getElementById('laplaceEdgeToggle').checked;
    const denoise = document.getElementById('laplaceDenoiseToggle').checked;
    
    if (edge && denoise) video.style.filter = "url(#filterBoth)";
    else if (edge) video.style.filter = "url(#filterEdge)";
    else if (denoise) video.style.filter = "url(#filterDenoise)";
    else video.style.filter = "none";
}

export function toggleCalibration() {
    State.calibration.isCalibMode = !State.calibration.isCalibMode;
    const btn = document.getElementById('btnCalib');
    const overlayCanvas = document.getElementById('overlayCanvas');
    
    btn.innerText = State.calibration.isCalibMode ? "DRAWING ON" : "OFF";
    btn.style.background = State.calibration.isCalibMode ? "#ff4444" : "#00ffcc";
    btn.style.color = State.calibration.isCalibMode ? "#fff" : "#000";
    
    if(State.calibration.isCalibMode) {
        overlayCanvas.classList.remove('nav-mode');
        updateStatus("<span style='color:#00ffcc;'>Draw a line on the video feed to set scale.</span>");
    } else {
        overlayCanvas.classList.add('nav-mode');
        updateStatus("<span style='color:orange;'>Calibration Closed. Interactive Mouse Navigation Enabled.</span>");
    }
}

export function getCanvasCoords(e) {
    const overlayCanvas = document.getElementById('overlayCanvas');
    const rect = overlayCanvas.getBoundingClientRect();
    let vidRatio = overlayCanvas.width / overlayCanvas.height;
    let elRatio = rect.width / rect.height;
    
    let renderW, renderH, offsetX = 0, offsetY = 0;
    if (vidRatio > elRatio) {
        renderW = rect.width; renderH = rect.width / vidRatio; offsetY = (rect.height - renderH) / 2;
    } else {
        renderH = rect.height; renderW = rect.height * vidRatio; offsetX = (rect.width - renderW) / 2;
    }
    
    let cX = e.clientX - rect.left - offsetX;
    let cY = e.clientY - rect.top - offsetY;
    
    return {
        x: cX * (overlayCanvas.width / renderW),
        y: cY * (overlayCanvas.height / renderH)
    };
}

export function updateCalibrationScale() {
    const calibValEl = document.getElementById('calibValue');
    const calibUnitEl = document.getElementById('calibUnit');
    const calibVal = parseFloat(calibValEl ? calibValEl.value : 0);
    const calibUnit = calibUnitEl ? calibUnitEl.value : 'um';

    State.calibration.activeUnit = calibUnit;

    const dx = State.calibration.lineEnd.x - State.calibration.lineStart.x;
    const dy = State.calibration.lineEnd.y - State.calibration.lineStart.y;
    const distPx = Math.sqrt(dx * dx + dy * dy);

    if (distPx > 2 && !isNaN(calibVal) && calibVal > 0) {
        State.calibration.pixelsPerUnit = distPx / calibVal;
        updateStatus(`<span style="color:#00ffcc;">Scale Calibrated: ${State.calibration.pixelsPerUnit.toFixed(2)} px/${calibUnit} (${distPx.toFixed(1)} px = ${calibVal} ${calibUnit})</span>`);
    }
}

export function handleOverlayMouseDown(e) {
    if (!State.calibration.isCalibMode || !State.connections.videoStream) return;
    const coords = getCanvasCoords(e);
    State.calibration.isDrawingLine = true;
    State.calibration.lineStart = { x: coords.x, y: coords.y };
    State.calibration.lineEnd = { x: coords.x, y: coords.y };
}

export function handleOverlayMouseMove(e) {
    if (!State.calibration.isCalibMode || !State.calibration.isDrawingLine) return;
    const coords = getCanvasCoords(e);
    State.calibration.lineEnd = { x: coords.x, y: coords.y };
}

export function handleOverlayMouseUp(e) {
    if (!State.calibration.isCalibMode || !State.calibration.isDrawingLine) return;
    State.calibration.isDrawingLine = false;
    const coords = getCanvasCoords(e);
    State.calibration.lineEnd = { x: coords.x, y: coords.y };
    updateCalibrationScale();
}

export function handleOverlayClick(e) {
    if (State.calibration.isCalibMode) return;
    if (!State.connections.videoStream) return;
    if (State.calibration.pixelsPerUnit <= 0) {
        return updateStatus("<span style='color:orange;'>Calibrate scale first to enable Click-to-Center navigation.</span>");
    }
    if (!State.connections.isStageConnected) return updateStatus("ERROR: Stage Port OFF.");
    if (State.stage.isHalted) return updateStatus("<span style='color:red;'>ERROR: Firmware is locked.</span>");

    const coords = getCanvasCoords(e);
    if (State.calibration.clickTimeout) clearTimeout(State.calibration.clickTimeout);

    State.calibration.clickTimeout = setTimeout(() => {
        const overlayCanvas = document.getElementById('overlayCanvas');
        const cx = overlayCanvas.width / 2;
        const cy = overlayCanvas.height / 2;

        let unitFactor = 1.0;
        if (State.calibration.activeUnit === "um") unitFactor = 0.001;
        else if (State.calibration.activeUnit === "nm") unitFactor = 0.000001;

        const rawDx = ((coords.x - cx) / State.calibration.pixelsPerUnit) * unitFactor;
        const rawDy = ((cy - coords.y) / State.calibration.pixelsPerUnit) * unitFactor;

        const actualDx = rawDx * State.stage.invX;
        const actualDy = rawDy * State.stage.invY;

        const { limL, limR } = getHardwareLimits();
        const Gv = calculateGv();
        if (actualDx !== 0 || actualDy !== 0) {
            if (Gv >= limR && limR !== 0) return toggleHardStop(true, `Pre-Halt (Gv Limit)`);
            if (Gv <= limL && limL !== 0) return toggleHardStop(true, `Pre-Halt (Gv Limit)`);
        }

        const nx = State.stage.currX + actualDx;
        const ny = State.stage.currY + actualDy;

        if (actualDx > 0 && State.session.limits.xPos !== null && nx > State.session.limits.xPos) return updateStatus("SW BOUND: X+");
        if (actualDx < 0 && State.session.limits.xNeg !== null && nx < State.session.limits.xNeg) return updateStatus("SW BOUND: X-");
        if (actualDy > 0 && State.session.limits.yPos !== null && ny > State.session.limits.yPos) return updateStatus("SW BOUND: Y+");
        if (actualDy < 0 && State.session.limits.yNeg !== null && ny < State.session.limits.yNeg) return updateStatus("SW BOUND: Y-");

        moveStage(actualDx, actualDy, 0, 1.0);
    }, 200);
}

// ==========================================
// RECENT IMAGES GALLERY & MAGNIFIED VIEWER
// ==========================================
export function addRecentImage(entry) {
    State.camera.recentImages.push(entry);
    State.camera.selectedRecentIndex = State.camera.recentImages.length - 1;
    renderRecentImages();
    if (State.camera.isRecentModalOpen) {
        updateRecentModalView();
    }
}

export function renderRecentImages() {
    const listEl = document.getElementById('recentImagesList');
    if (!listEl) return;

    const images = State.camera.recentImages;
    if (!images || images.length === 0) {
        listEl.innerHTML = '<div class="recent-empty">No images captured yet</div>';
        return;
    }

    listEl.innerHTML = '';
    // Render most recent first in the sidebar box for immediate visibility
    for (let i = images.length - 1; i >= 0; i--) {
        const item = images[i];
        const row = document.createElement('div');
        row.className = 'recent-item' + (i === State.camera.selectedRecentIndex ? ' active' : '');
        row.title = `Click to magnify: ${item.name}`;

        const thumb = document.createElement('img');
        thumb.className = 'recent-thumb';
        thumb.src = item.url;
        thumb.alt = item.name;

        const info = document.createElement('div');
        info.className = 'recent-info';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'recent-name';
        nameSpan.textContent = item.name;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'recent-time';
        const stabBadge = (item.stabTimeMs !== undefined && item.stabTimeMs !== null)
            ? ` • t_stab: ${item.stabTimeMs}ms`
            : '';
        timeSpan.textContent = `${item.time || ''}${stabBadge}`;

        info.appendChild(nameSpan);
        info.appendChild(timeSpan);
        row.appendChild(thumb);
        row.appendChild(info);

        row.addEventListener('click', () => {
            openRecentModal(i);
        });

        listEl.appendChild(row);
    }
}

export function updateRecentModalView() {
    const modal = document.getElementById('recentImagesModal');
    if (!modal) return;

    const images = State.camera.recentImages;
    if (!images || images.length === 0) {
        closeRecentModal();
        return;
    }

    if (State.camera.selectedRecentIndex < 0 || State.camera.selectedRecentIndex >= images.length) {
        State.camera.selectedRecentIndex = images.length - 1;
    }

    const idx = State.camera.selectedRecentIndex;
    const current = images[idx];

    const titleEl = document.getElementById('recentModalTitle');
    const counterEl = document.getElementById('recentModalCounter');
    const imgEl = document.getElementById('recentModalImg');
    const captionEl = document.getElementById('recentModalCaption');
    const stripEl = document.getElementById('recentModalStrip');

    if (titleEl) titleEl.textContent = current.name;
    if (counterEl) counterEl.textContent = `${idx + 1} / ${images.length}`;
    if (imgEl) {
        imgEl.src = current.url;
        imgEl.alt = current.name;
    }
    if (captionEl) {
        const stabInfo = (current.stabTimeMs !== undefined && current.stabTimeMs !== null)
            ? `  •  LED Stab: ${current.stabTimeMs} ms`
            : '';
        captionEl.textContent = `${current.name}${current.time ? '  •  Captured at ' + current.time : ''}${stabInfo}`;
    }

    if (stripEl) {
        stripEl.innerHTML = '';
        images.forEach((item, i) => {
            const cell = document.createElement('div');
            cell.className = 'recent-strip-item' + (i === idx ? ' active' : '');
            cell.title = item.name;

            const thumb = document.createElement('img');
            thumb.src = item.url;
            thumb.alt = item.name;

            const label = document.createElement('span');
            label.textContent = item.name;

            cell.appendChild(thumb);
            cell.appendChild(label);
            cell.addEventListener('click', () => {
                State.camera.selectedRecentIndex = i;
                renderRecentImages();
                updateRecentModalView();
            });
            stripEl.appendChild(cell);
        });
    }
}

export function openRecentModal(index = null) {
    const images = State.camera.recentImages;
    if (!images || images.length === 0) {
        updateStatus("<span style='color:orange;'>No recent images to magnify yet. Capture an image first.</span>");
        return;
    }
    if (index !== null && index >= 0 && index < images.length) {
        State.camera.selectedRecentIndex = index;
    } else if (State.camera.selectedRecentIndex < 0) {
        State.camera.selectedRecentIndex = images.length - 1;
    }

    State.camera.isRecentModalOpen = true;
    const modal = document.getElementById('recentImagesModal');
    if (modal) modal.style.display = 'flex';
    renderRecentImages();
    updateRecentModalView();
}

export function closeRecentModal() {
    State.camera.isRecentModalOpen = false;
    const modal = document.getElementById('recentImagesModal');
    if (modal) modal.style.display = 'none';
}

export function stepRecentImage(delta) {
    const images = State.camera.recentImages;
    if (!images || images.length === 0) return;
    const len = images.length;
    State.camera.selectedRecentIndex = (State.camera.selectedRecentIndex + delta + len) % len;
    renderRecentImages();
    updateRecentModalView();
}

async function decodePngFileToRGBBuffer(fileHandle, width = 1280, height = 720) {
    const file = await fileHandle.getFile();
    const bitmap = await createImageBitmap(file);
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    return new Uint8Array(ctx.getImageData(0, 0, width, height).data);
}

export async function restoreCalibrationFramesFromFolder(folderHandle) {
    if (!folderHandle) return;
    try {
        const darkHandle = await folderHandle.getFileHandle("noise_darkframe_rgb.png");
        State.camera.darkFrameRGB = await decodePngFileToRGBBuffer(darkHandle);
        updateStatus("<span style='color:#00ffcc;'>Restored Sub Noise dark frame from session folder.</span>");
    } catch (e) {}

    try {
        const flatHandle = await folderHandle.getFileHandle("background_flatfield_rgb.png");
        State.camera.backgroundFrameRGB = await decodePngFileToRGBBuffer(flatHandle);
        updateStatus("<span style='color:#00ffcc;'>Restored Div Flat reference frame from session folder.</span>");
    } catch (e) {}
}

// ==========================================
// DYNAMIC LED STABILIZATION ENGINE (dI/dt from Histogram, Δt = 10 ms)
// ==========================================
export function updateLedStabilizationUI(stabTimeMs) {
    if (stabTimeMs === null || stabTimeMs === undefined || isNaN(stabTimeMs)) return;
    const rounded = Math.round(Number(stabTimeMs));
    State.camera.ledStabilizationTimeMs = rounded;
    const el = document.getElementById('ledStabTimeDisplay');
    if (el) {
        el.textContent = `LED Stab Time: ${rounded} ms (Δt=10ms, dI/dt≈0)`;
    }
}

/**
 * Monitors the histogram-derived intensity sum I(t) = Σ_{b=0}^{255} b * hist[b](t)
 * and its time derivative dI/dt(t) = (I(t) - I(t - 10 ms)) / 10 ms.
 * Finds the time where intensity stabilizes and does not overshoot or plateaus
 * (derivative zero at time larger than t = t + 1), stores the obtained time as
 * LED stabilization time, and resolves only once the light has stabilized.
 */
export function waitForLedStabilization(imageName = "", baselineHist = null, wasLightOff = false) {
    return new Promise((resolve) => {
        // Ensure the 10 ms histogram derivative loop is running
        startHistogramDerivativeLoop();

        const tStart = performance.now();
        const samples = [];
        let resolved = false;

        // Compute baseline histogram statistics before illumination transition
        const refHist = baselineHist
            ? new Uint32Array(baselineHist)
            : new Uint32Array(State.camera.currentHistogram);
        const baselineStats = calculateFromHistogram(refHist);

        // Determine if an active LED turn-on response from dark/dim state is expected
        const lightSliderVal = parseInt(document.getElementById('lightSlider')?.value || "0", 10);
        const expectIlluminationRise = Boolean(
            State.connections.isLightConnected && wasLightOff && lightSliderVal > 0
        );
        let responseDetected = !expectIlluminationRise;
        let responseStepIndex = expectIlluminationRise ? -1 : 0;

        // Thresholds for Δt = 10 ms histogram derivative plateau (dI/dt ≈ 0 without overshoot)
        const DERIV_ZERO_MEAN_PER_MS = 0.012;    // <= 0.12 gray-level change per 10 ms step per pixel
        const DERIV_ZERO_REL_PER_MS = 0.00015;   // <= 0.15% relative intensity change per 10 ms step
        const PLATEAU_WINDOW_STEPS = 16;         // 16 consecutive 10 ms steps (160 ms across ~5 camera frames)
        const WINDOW_SLOPE_TOLERANCE = 0.004;    // Net drift across 160 ms plateau window <= 0.004 gray/ms
        const MAX_RESPONSE_WAIT_MS = 3000;       // Max wait for initial serial + LED hardware response if sample is opaque
        const MAX_STABILIZATION_WAIT_MS = 8000;  // Overall safety ceiling so capture cannot hang indefinitely

        const cleanupAndFinish = (stabTimeMs, finalSample) => {
            if (resolved) return;
            resolved = true;
            State.camera.onFrameIntensitySample = null;
            State.camera.isLedStabilized = true;
            clearTimeout(safetyTimeout);

            const validStabMs = Math.max(DERIVATIVE_DT_MS, Math.round(stabTimeMs));
            updateLedStabilizationUI(validStabMs);

            const record = {
                timestamp: new Date().toISOString(),
                imageName: imageName || "capture",
                stabilizationTimeMs: validStabMs,
                dtMs: DERIVATIVE_DT_MS,
                finalIntensitySum: finalSample ? Math.round(finalSample.sumIntensity) : (State.camera.frameIntensitySum || 0),
                finalDerivative: finalSample ? Number(finalSample.dIdt.toFixed(2)) : 0,
                framesElapsed: samples.length
            };
            State.camera.ledStabilizationHistory.push(record);
            if (State.camera.ledStabilizationHistory.length > 200) {
                State.camera.ledStabilizationHistory.shift();
            }

            resolve(record);
        };

        const handleSample = (sample) => {
            if (resolved) return;

            const k = samples.length; // Discrete 10 ms step index t = 0, 1, 2, ...
            const N = Math.max(1, sample.pixelCount || baselineStats.pixelCount || (1280 * 720));
            const elapsedMs = sample.timestamp - tStart;

            if (k === 0) {
                samples.push({
                    k: 0,
                    timestamp: sample.timestamp,
                    elapsedMs: elapsedMs,
                    sumIntensity: sample.sumIntensity,
                    meanIntensity: sample.meanIntensity,
                    dt: DERIVATIVE_DT_MS,
                    dIdt: 0,
                    meanDeriv: 0,
                    relDeriv: 0,
                    isZeroDeriv: false
                });
                return;
            }

            const prev = samples[k - 1];
            const dt = DERIVATIVE_DT_MS; // Fixed Δt = 10 ms derivative step
            const dIdt = (sample.sumIntensity - prev.sumIntensity) / dt;
            const meanDeriv = (sample.meanIntensity - prev.meanIntensity) / dt;
            const relDeriv = Math.abs(dIdt) / Math.max(sample.sumIntensity, N * 10);

            // Detect when the histogram reflects the LED turning on from the dark baseline
            if (!responseDetected) {
                const meanDeltaFromBaseline = Math.abs(sample.meanIntensity - baselineStats.meanIntensity);
                const histShiftRatio = sample.histogram
                    ? calculateHistogramShiftRatio(sample.histogram, refHist, N)
                    : 0;

                if (
                    meanDeltaFromBaseline >= 1.0 ||
                    histShiftRatio >= 0.025 ||
                    Math.abs(meanDeriv) >= 0.025 ||
                    elapsedMs >= MAX_RESPONSE_WAIT_MS
                ) {
                    responseDetected = true;
                    responseStepIndex = k;
                }
            }

            const isZeroDeriv = (Math.abs(meanDeriv) <= DERIV_ZERO_MEAN_PER_MS) || (relDeriv <= DERIV_ZERO_REL_PER_MS);

            const currentEntry = {
                k: k,
                timestamp: sample.timestamp,
                elapsedMs: elapsedMs,
                sumIntensity: sample.sumIntensity,
                meanIntensity: sample.meanIntensity,
                dt: dt,
                dIdt: dIdt,
                meanDeriv: meanDeriv,
                relDeriv: relDeriv,
                isZeroDeriv: isZeroDeriv
            };
            samples.push(currentEntry);

            // Enforce time larger than t = t + 1 (discrete step k > 2) AND wait until LED response has begun
            if (k <= 2 || !responseDetected) return;

            // Ensure we have collected a full plateau window of 10 ms steps after the LED response started
            const stepsSinceResponse = k - Math.max(0, responseStepIndex);
            if (stepsSinceResponse < PLATEAU_WINDOW_STEPS || samples.length <= PLATEAU_WINDOW_STEPS) {
                return;
            }

            // Verify that across the entire window [k - PLATEAU_WINDOW_STEPS + 1 ... k]:
            // 1. Every 10 ms step has dI/dt ≈ 0 (isZeroDeriv === true),
            // 2. Net slope across the window is ≈ 0 (not slowly creeping up/down),
            // 3. Second derivative / half-window slope difference is ≈ 0 (no overshoot inflection).
            const winStartIdx = k - PLATEAU_WINDOW_STEPS;
            for (let i = winStartIdx + 1; i <= k; i++) {
                if (!samples[i].isZeroDeriv) {
                    return;
                }
            }

            const startSample = samples[winStartIdx];
            const midSample = samples[winStartIdx + Math.floor(PLATEAU_WINDOW_STEPS / 2)];
            const endSample = currentEntry;

            const windowDurationMs = PLATEAU_WINDOW_STEPS * DERIVATIVE_DT_MS;
            const halfDurationMs = Math.max(DERIVATIVE_DT_MS, (PLATEAU_WINDOW_STEPS / 2) * DERIVATIVE_DT_MS);

            const netWindowSlope = Math.abs(endSample.meanIntensity - startSample.meanIntensity) / windowDurationMs;
            const firstHalfSlope = (midSample.meanIntensity - startSample.meanIntensity) / halfDurationMs;
            const secondHalfSlope = (endSample.meanIntensity - midSample.meanIntensity) / halfDurationMs;
            const curvatureDiff = Math.abs(secondHalfSlope - firstHalfSlope);

            if (netWindowSlope <= WINDOW_SLOPE_TOLERANCE && curvatureDiff <= (WINDOW_SLOPE_TOLERANCE * 1.5)) {
                cleanupAndFinish(elapsedMs, currentEntry);
            }
        };

        State.camera.onFrameIntensitySample = handleSample;

        const safetyTimeout = setTimeout(() => {
            const lastSample = samples.length > 0 ? samples[samples.length - 1] : null;
            const totalElapsed = performance.now() - tStart;
            cleanupAndFinish(totalElapsed, lastSample);
        }, MAX_STABILIZATION_WAIT_MS);
    });
}

export function captureImage(customName = null) {
    return new Promise(async (resolve) => {
        if (!State.connections.videoStream || !State.session.experiment) {
            if (!State.session.experiment) updateStatus("<span style='color:red;'>Error: No Session Directory.</span>");
            return resolve(false);
        }
        
        if (customName === null) {
            let dateStr = new Date().toISOString().replace(/[:.]/g, "-").split('T');
            let defaultName = `img_${dateStr[0]}_${dateStr[1].substring(0,6)}`;
            let userInput = prompt("Enter a name for this image:", defaultName);
            if (!userInput) {
                updateStatus("<span style='color:orange;'>Image capture cancelled by user.</span>");
                return resolve(false);
            }
            customName = userInput;
        }

        // Refresh histogram baseline prior to turning ON illumination
        updateFrameAndHistogram();
        const baselineHist = new Uint32Array(State.camera.currentHistogram);
        const currentProto = (State.connections.currentLightProtocol || '000').trim();
        const wasLightOff = (currentProto === '000' || currentProto === '000 000 000');

        // Lock illumination so the light cannot be turned off until stabilization completes
        State.camera.isStabilizingLed = true;
        State.camera.isLedStabilized = false;

        try {
            // Turn ON illumination and wait dynamically until histogram intensity sum ΣI plateaus (dI/dt = 0 for t > t + 1, Δt = 10 ms)
            await turnOnLight();
            updateStatus("<span style='color:#ffaa00;'>Stabilizing LED illumination (histogram dI/dt, Δt = 10 ms)...</span>");
            const stabRecord = await waitForLedStabilization(customName, baselineHist, wasLightOff);
            const stabTimeMs = stabRecord.stabilizationTimeMs;

            // Ensure the latest stabilized frame is rendered onto cameraFeedCanvas right before snapping
            updateFrameAndHistogram();
            updateStatus(`<span style="color:#00ffcc;">LED Stabilized at t = ${stabTimeMs} ms (Δt = 10 ms, dI/dt ≈ 0). Snapping...</span>`);

            const cameraFeedCanvas = document.getElementById('cameraFeed');
            const canvas = document.getElementById('captureCanvas');
            const format = document.getElementById('imgFormat').value;
            const ext = format.split('/')[1];

            canvas.width = cameraFeedCanvas.width; 
            canvas.height = cameraFeedCanvas.height;
            const ctx = canvas.getContext('2d');
            
            const edge = document.getElementById('laplaceEdgeToggle').checked;
            const denoise = document.getElementById('laplaceDenoiseToggle').checked;
            
            if (edge && denoise) ctx.filter = "url(#filterBoth)";
            else if (edge) ctx.filter = "url(#filterEdge)";
            else if (denoise) ctx.filter = "url(#filterDenoise)";
            
            ctx.drawImage(cameraFeedCanvas, 0, 0, canvas.width, canvas.height);
            ctx.filter = "none"; 
            
            if (State.calibration.pixelsPerUnit > 0) renderScaleBar(ctx, canvas.width, canvas.height);

            // Snapshot measurements while the stabilized frame is active
            let measurementsStr = "";
            let objectsCount = 0;
            const timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
            if (State.analysis.isObjectAnalysisActive && State.analysis.currentObjects.length > 0) {
                let scaleSq = (State.calibration.pixelsPerUnit > 0) ? (State.calibration.pixelsPerUnit * State.calibration.pixelsPerUnit) : 1;
                let scaleLin = (State.calibration.pixelsPerUnit > 0) ? State.calibration.pixelsPerUnit : 1;
                const fileName = `${customName}.${ext}`;

                State.analysis.currentObjects.forEach(obj => {
                    let a = (obj.area / scaleSq).toFixed(3);
                    let p = (obj.perimeter / scaleLin).toFixed(3);
                    let cxScaled = (obj.cx / scaleLin).toFixed(3);
                    let cyScaled = (obj.cy / scaleLin).toFixed(3);
                    
                    measurementsStr += `${fileName}\t${obj.id}\t${timeStr}\t${a}\t${p}\t${cxScaled}\t${cyScaled}\n`;
                });
                objectsCount = State.analysis.currentObjects.length;
            }

            // Release stabilization lock and turn OFF illumination (000 000 000) ONLY after stabilization and frame capture
            State.camera.isStabilizingLed = false;
            await turnOffLight();
            
            canvas.toBlob(async (blob) => {
                const fileName = `${customName}.${ext}`;
                try {
                    if (blob) {
                        const objUrl = URL.createObjectURL(blob);
                        addRecentImage({ name: fileName, url: objUrl, time: timeStr, stabTimeMs: stabTimeMs });
                    }

                    if (State.session.expFolderHandle && blob) {
                        try {
                            const fh = await State.session.expFolderHandle.getFileHandle(fileName, { create: true });
                            const wr = await fh.createWritable();
                            await wr.write(blob);
                            await wr.close();
                        } catch (err) {}
                    }

                    let fd = new FormData();
                    fd.append("experiment", State.session.experiment);
                    fd.append("filename", fileName);
                    fd.append("image", blob, fileName);

                    if (measurementsStr) {
                        fd.append("measurements", measurementsStr);
                    }

                    const res = await fetch('/api/save', { method: 'POST', body: fd });
                    if (!res.ok) throw new Error(await res.text());
                    
                    updateStatus(`<span style="color:#00ffcc;">Saved Image: ${fileName} (LED Stab: ${stabTimeMs} ms)</span>`);
                    if (measurementsStr) updateStatus(`<span style="color:#00ffcc;">Appended ${objectsCount} objects to measurements.txt</span>`);
                    resolve(true);
                } catch (e) {
                    updateStatus(`<span style="color:red;">Error saving data: ${e.message}</span>`);
                    resolve(false);
                }
            }, format);
        } catch (err) {
            State.camera.isStabilizingLed = false;
            updateStatus(`<span style="color:red;">Capture Error: ${err.message}</span>`);
            resolve(false);
        }
    });
}