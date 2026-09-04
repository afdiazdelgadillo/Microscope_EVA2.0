/**
 * Main Application Bootstrapper
 * Serves as Phase 5 entry point, securely tying all initialized logic modules to the browser.
 */
import { initUI } from './modules/ui.js';
import { fetchStagePorts } from './modules/hardware.js';
import { populateCameras } from './modules/camera.js';
import { updateStatus } from './core/utils.js';

window.onload = () => { 
    try {
        // 1. Map all HTML interactions to JS Modules safely
        initUI();
    } catch (e) {
        console.error("UI Mapping Warning:", e);
        updateStatus(`<span style="color:orange;">Warning: UI mapping partially incomplete. Details in console.</span>`);
    }
    
    // 2. Query system states (Guaranteed to run even if UI mapping throws an error)
    fetchStagePorts(); 
    populateCameras(); 
    
    // 3. Set UI defaults
    const scaleEl = document.getElementById('scaleValue');
    const zWheelEl = document.getElementById('zWheelValue');
    const feedEl = document.getElementById('feedValue');
    const overlay = document.getElementById('overlayCanvas');

    if (scaleEl) scaleEl.innerText = "Step: 1.0";
    if (zWheelEl) zWheelEl.innerText = "0.100";
    if (feedEl) feedEl.innerText = "F055";
    if (overlay) overlay.classList.add('nav-mode');
    
    updateStatus("<span style='color:#ff4444; font-weight:bold;'>⚠️ ATTENTION: Limits (Gv) are initialized to 0. Please explicitly set limits before moving.</span>");
};