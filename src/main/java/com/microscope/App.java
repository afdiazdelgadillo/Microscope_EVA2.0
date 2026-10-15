package com.microscope;

import com.fazecast.jSerialComm.SerialPort;
import io.javalin.Javalin;
import io.javalin.http.UploadedFile;
import io.javalin.http.staticfiles.Location;
import java.awt.Desktop;
import java.io.File;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;

public class App {
    private static SerialPort illuminationPort;
    private static SerialPort stagePort;
    private static Javalin app;

    public static void main(String[] args) {
        app = Javalin.create(config -> {
            config.staticFiles.add("/public", Location.CLASSPATH);
            config.plugins.enableCors(cors -> cors.add(it -> it.anyHost()));
        }).start(8080);

        System.out.println("Microscope Controller active at http://127.0.0.1:8080");
        openBrowser("http://127.0.0.1:8080");

        app.get("/api/ports", ctx -> {
            StringBuilder json = new StringBuilder("[");
            SerialPort[] ports = SerialPort.getCommPorts();
            for (int i = 0; i < ports.length; i++) {
                json.append("\"").append(ports[i].getSystemPortName()).append("\"");
                if (i < ports.length - 1) {
                    json.append(",");
                }
            }
            json.append("]");
            ctx.contentType("application/json").result(json.toString());
        });

        app.post("/api/stage", ctx -> {
            String portName = ctx.queryParam("port");
            String command = ctx.queryParam("cmd");

            try {
                if (stagePort == null || !stagePort.getSystemPortName().equals(portName)) {
                    if (stagePort != null) stagePort.closePort();
                    stagePort = SerialPort.getCommPort(portName);
                    stagePort.setBaudRate(115200);
                    stagePort.setNumDataBits(8);
                    stagePort.setNumStopBits(1);
                    stagePort.setParity(0);
                    if (!stagePort.openPort()) throw new Exception("Stage Port Busy");
                }
                String payload = command + "\r";
                stagePort.writeBytes(payload.getBytes(), payload.length());
                ctx.result("Stage Sent: " + command);
            } catch (Exception e) {
                ctx.status(500).result("Error: " + e.getMessage());
            }
        });

        app.post("/api/save", ctx -> {
            try {
                String exp = ctx.formParam("experiment");
                String filename = ctx.formParam("filename");
                UploadedFile file = ctx.uploadedFile("image");
                String measurements = ctx.formParam("measurements");

                File dir = new File("experiments/" + exp);
                if (!dir.exists()) dir.mkdirs();

                if (file != null) {
                    Files.copy(file.content(), new File(dir, filename).toPath(), StandardCopyOption.REPLACE_EXISTING);
                }

                if (measurements != null && !measurements.isEmpty()) {
                    File txt = new File(dir, "measurements.txt");
                    if (!txt.exists()) {
                        Files.writeString(txt.toPath(), "Image_Filename\tObject_Num\tSys_Time\tArea\tPerimeter\tCentroid_X\tCentroid_Y\n");
                    }
                    Files.writeString(txt.toPath(), measurements, StandardOpenOption.APPEND);
                }
                ctx.result("Saved successfully");
            } catch (Exception e) {
                ctx.status(500).result("Error saving: " + e.getMessage());
            }
        });

        app.post("/api/saveLog", ctx -> {
            try {
                String exp = ctx.formParam("experiment");
                String filename = ctx.formParam("filename");
                String jsonData = ctx.formParam("data");

                File dir = new File("experiments/" + exp);
                if (!dir.exists()) dir.mkdirs();

                File jsonFile = new File(dir, filename);
                Files.writeString(jsonFile.toPath(), jsonData);
                ctx.result("Log saved successfully");
            } catch (Exception e) {
                ctx.status(500).result("Error saving log: " + e.getMessage());
            }
        });

        app.get("/api/exit", ctx -> {
            new Thread(() -> {
                try {
                    if (illuminationPort != null) illuminationPort.closePort();
                    if (stagePort != null) stagePort.closePort();
                    Thread.sleep(500);
                    app.stop();
                    System.exit(0);
                } catch (Exception e) {
                    System.exit(1);
                }
            }).start();
            ctx.result("Shutting down...");
        });
    }

    private static void openBrowser(String url) {
        try {
            if (Desktop.isDesktopSupported()) {
                Desktop.getDesktop().browse(new URI(url));
            }
        } catch (Exception e) {
            System.out.println("Could not open browser automatically. Please visit " + url);
        }
    }
}
