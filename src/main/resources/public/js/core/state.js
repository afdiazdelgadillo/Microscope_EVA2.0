/**
 * Global State Management (Single Source of Truth)
 * All modules will import this object to read/write shared data.
 */
export const State = {
    // 1. Session & Experiment Data
    session: {
        user: "",
        experiment: "",
        limits: { xPos: null, xNeg: null, yPos: null, yNeg: null, zPos: null, zNeg: null }
    },
    
    // 2. Microscope Stage & Kinematics
    stage: {
        currX: 0.0,
        currY: 0.0,
        currZ: 0.0,
        invX: 1,
        invY: 1,
        invZ: 1,
        isHalted: false,
        // Hardware Constants
        scales: [10.0, 1.0, 0.1, 0.01, 0.001, 0.0001],
        zWheelSteps: [0.10, 0.08, 0.06, 0.04, 0.02, 0.01, 0.005],
        feedRates: [25, 40, 55, 70, 85, 100]
    },

    // 3. Hall Effect Sensor Telemetry
    sensor: {
        previousGauss: null,
        currentGauss: 0.0
    },

    // 4. Hardware & Media Connections
    connections: {
        videoStream: null,
        illuminationPort: null,
        serialReader: null,
        isLightConnected: false,
        isStageConnected: false
    },

    // 5. Waypoints & Macro Automation
    automation: {
        waypoints: [],
        sequenceActive: false
    },

    // 6. Spatial Calibration (Pixels to mm/um)
    calibration: {
        isCalibMode: false,
        isDrawingLine: false,
        lineStart: { x: 0, y: 0 },
        lineEnd: { x: 0, y: 0 },
        pixelsPerUnit: 0,
        activeUnit: "um",
        clickTimeout: null
    },

    // 7. Camera & Visual Processing Pipeline
    camera: {
        isProcessingStream: false,
        captureNextFrameAsDark: false,
        captureNextFrameAsBackground: false,
        darkFrameRGB: null,
        backgroundFrameRGB: null
    },

    // 8. Machine Vision & Object Analysis
    analysis: {
        isObjectAnalysisActive: false,
        currentObjects: [],
        segVisited: null,
        segQueue: null
    }
};