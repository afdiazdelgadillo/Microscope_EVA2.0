import { State } from '../core/state.js';
import { updateStatus } from '../core/utils.js';

export function toggleObjectAnalysis() {
    State.analysis.isObjectAnalysisActive = !State.analysis.isObjectAnalysisActive;
    const btn = document.getElementById('btnToggleAnalysis');
    
    if (State.analysis.isObjectAnalysisActive) {
        btn.innerText = "Stop Real-Time Tracking";
        btn.style.background = "#ff4444";
        btn.style.color = "white";
        updateStatus("<span style='color:#00ffcc;'>Object Analysis Active. Dynamic Filtering initialized.</span>");
    } else {
        btn.innerText = "Start Real-Time Tracking";
        btn.style.background = "#00ffcc";
        btn.style.color = "black";
        State.analysis.currentObjects = [];
        updateStatus("<span style='color:orange;'>Object Analysis Disabled.</span>");
    }
}

export function getOtsuThreshold(grayData) {
    let hist = new Int32Array(256);
    for (let i = 0; i < grayData.length; i++) hist[grayData[i]]++;
    
    let total = grayData.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    
    let sumB = 0, wB = 0, wF = 0, varMax = 0, threshold = 0;
    for (let i = 0; i < 256; i++) {
        wB += hist[i];
        if (wB === 0) continue;
        wF = total - wB;
        if (wF === 0) break;
        
        sumB += i * hist[i];
        let mB = sumB / wB;
        let mF = (sum - sumB) / wF;
        
        let varBetween = wB * wF * (mB - mF) * (mB - mF);
        if (varBetween > varMax) {
            varMax = varBetween;
            threshold = i;
        }
    }
    return threshold;
}

export function analyzeFrame(gray, w, h) {
    let len = w * h;
    
    if (!State.analysis.segVisited || State.analysis.segVisited.length !== len) {
        State.analysis.segVisited = new Uint8Array(len);
        State.analysis.segQueue = new Int32Array(len);
    }
    
    let segVisited = State.analysis.segVisited;
    let segQueue = State.analysis.segQueue;
    segVisited.fill(0);
    
    let th = getOtsuThreshold(gray);
    let currentObjects = [];

    // BFS Connected Components
    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            let idx = y * w + x;
            if (gray[idx] > th && segVisited[idx] === 0) {
                let head = 0, tail = 0;
                segQueue[tail++] = idx;
                segVisited[idx] = 1;
                
                let area = 0, perimeter = 0;
                let sumX = 0, sumY = 0;
                let edges = [];

                while(head < tail) {
                    let curr = segQueue[head++];
                    let cx = curr % w;
                    let cy = Math.floor(curr / w);
                    area++;
                    sumX += cx;
                    sumY += cy;

                    let isEdge = false;
                    let nList = [curr - w, curr + w, curr - 1, curr + 1];
                    
                    for(let n=0; n<4; n++) {
                        let nIdx = nList[n];
                        if (gray[nIdx] <= th) {
                            isEdge = true; // Boundary
                        } else if (segVisited[nIdx] === 0) {
                            segVisited[nIdx] = 1;
                            segQueue[tail++] = nIdx;
                        }
                    }
                    if (isEdge) {
                        perimeter++;
                        edges.push(curr);
                    }
                }

                // Filter noise blobs < 50px
                if (area > 50) { 
                    currentObjects.push({
                        area: area,
                        perimeter: perimeter,
                        cx: sumX / area, // Centroid X
                        cy: sumY / area, // Centroid Y
                        edges: edges,
                        dropped: false
                    });
                }
            }
        }
    }

    // Spatial Hierarchical Filtering
    currentObjects.sort((a, b) => b.perimeter - a.perimeter);
    
    let filteredObjects = [];
    let newId = 1;

    for (let i = 0; i < currentObjects.length; i++) {
        if (currentObjects[i].dropped) continue;
        
        let objA = currentObjects[i];
        objA.id = newId++;
        filteredObjects.push(objA);

        let radiusA = Math.sqrt(objA.area / Math.PI); 

        for (let j = i + 1; j < currentObjects.length; j++) {
            if (currentObjects[j].dropped) continue;
            let objB = currentObjects[j];
            
            let dx = objA.cx - objB.cx;
            let dy = objA.cy - objB.cy;
            let dist = Math.sqrt(dx*dx + dy*dy);
            
            if (dist < radiusA) {
                currentObjects[j].dropped = true; 
            }
        }
    }
    
    State.analysis.currentObjects = filteredObjects;
}