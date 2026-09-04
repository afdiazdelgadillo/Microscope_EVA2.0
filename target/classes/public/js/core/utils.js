/**
 * Shared Utilities
 * Provides global helper functions used across multiple modules.
 */

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function updateStatus(msg) {
    const log = document.getElementById('status');
    if (!log) return;
    const time = new Date().toLocaleTimeString('en-US', { hour12: false, hour: "numeric", minute: "numeric", second: "numeric" });
    log.innerHTML = `<span style="color:#555;">[${time}]</span> ${msg}<br>` + log.innerHTML;
    
    // Prevent the DOM from overloading by capping the log history
    if (log.innerHTML.length > 5000) {
        log.innerHTML = log.innerHTML.substring(0, 5000);
    }
}