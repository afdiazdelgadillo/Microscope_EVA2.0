import { State } from '../core/state.js';
import { updateStatus } from '../core/utils.js';
import { analyzeFrame } from './vision.js';
import { moveToCalibrationZ } from './hardware.js';

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

export async function toggleCamera() {
    const btn = document.getElementById('camToggle');
    const cameraSelect = document.getElementById('cameraSelect');
    const rawVideo = document.getElementById('rawVideo');
    const cameraFeedCanvas = document.getElementById('cameraFeed');
    const overlayCanvas = document.getElementById('overlayCanvas');
    
    if (State.connections.videoStream) {
        State.connections.videoStream.getTracks().forEach(track => track.stop());
        State.connections.videoStream = null; 
        rawVideo.srcObject = null;
        State.camera.isProcessingStream = false;
        btn.innerText = "Start Camera"; 
        btn.classList.remove('stop');
        
        const canvas = document.getElementById('intensityBar');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Clear the histogram as well
        const histCanvas = document.getElementById('histogramCanvas');
        if(histCanvas) histCanvas.getContext('2d').clearRect(0, 0, histCanvas.width, histCanvas.height);

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

export function processFrameRGB() {
    if (!State.camera.isProcessingStream) return;

    const rawVideo = document.getElementById('rawVideo');
    const cameraFeedCanvas = document.getElementById('cameraFeed');
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

    let minVal = 255, maxVal = 0, sumVal = 0;

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

        if (lumInt < minVal) minVal = lumInt;
        if (lumInt > maxVal) maxVal = lumInt;
        sumVal += lumInt;
    }

    if (State.analysis.isObjectAnalysisActive) { analyzeFrame(gray, w, h); }
    
    drawOverlay();
    drawIntensityBar(minVal, maxVal, sumVal / len);
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

export function captureImage(customName = null) {
    return new Promise((resolve) => {
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
        
        canvas.toBlob(async (blob) => {
            const fileName = `${customName}.${ext}`;
            try {
                let fd = new FormData();
                fd.append("experiment", State.session.experiment);
                fd.append("filename", fileName);
                fd.append("image", blob, fileName);

                let measurementsStr = "";
                if (State.analysis.isObjectAnalysisActive && State.analysis.currentObjects.length > 0) {
                    let timeStr = new Date().toLocaleTimeString('en-US', { hour12: false });
                    let scaleSq = (State.calibration.pixelsPerUnit > 0) ? (State.calibration.pixelsPerUnit * State.calibration.pixelsPerUnit) : 1;
                    let scaleLin = (State.calibration.pixelsPerUnit > 0) ? State.calibration.pixelsPerUnit : 1;

                    State.analysis.currentObjects.forEach(obj => {
                        let a = (obj.area / scaleSq).toFixed(3);
                        let p = (obj.perimeter / scaleLin).toFixed(3);
                        let cxScaled = (obj.cx / scaleLin).toFixed(3);
                        let cyScaled = (obj.cy / scaleLin).toFixed(3);
                        
                        measurementsStr += `${fileName}\t${obj.id}\t${timeStr}\t${a}\t${p}\t${cxScaled}\t${cyScaled}\n`;
                    });
                    fd.append("measurements", measurementsStr);
                }

                const res = await fetch('/api/save', { method: 'POST', body: fd });
                if (!res.ok) throw new Error(await res.text());
                
                updateStatus(`<span style="color:#00ffcc;">Saved Image: ${fileName}</span>`);
                if (measurementsStr) updateStatus(`<span style="color:#00ffcc;">Appended ${State.analysis.currentObjects.length} objects to measurements.txt</span>`);
                resolve(true);
            } catch (e) {
                updateStatus(`<span style="color:red;">Error saving data: ${e.message}</span>`);
                resolve(false);
            }
        }, format);
    });
}