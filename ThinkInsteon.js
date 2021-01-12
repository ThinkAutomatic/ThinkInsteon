"use strict";

var td = require("thinkdevice");
var Insteon = require("home-controller").Insteon;
var insteon = new Insteon();

var portNum = 0;
var linkData = null;

function debugOut(label, message) {
  if (message) {
    if (message.constructor == Object) {
      console.log(label + ":" + JSON.stringify(message));
    } else {
      console.log(label + ":" + message.toString());
    }
  } else {
    console.log(label);
  }
}

function nextPort() {
  td.unlockPeripheral("/dev/ttyUSB" + portNum.toString());

  if (portNum >= 126) {
    debugOut("Unable to find PLC");
  } else {
    portNum++;
    findHub();
  }
}

insteon.on("error", function (error) {
  nextPort();
});
insteon.on("close", function (error) {
  nextPort();
});

insteon.on("command", function (command) {
  //  debugOut('command', command);
});

function getThermostatStatus(insteonId) {
  // get status
  insteon
    .thermostat(insteonId)
    .status()
    .then(function (status) {
      console.log(status);
      if (status.unit == "F" || status.unit == "C") {
        status["coolTemp" + status.unit] = status.setpoints.cool;
        status["heatTemp" + status.unit] = status.setpoints.heat;
        status.fan = status.fan ? "on" : "auto";
        status.silent = true; // this is to avoid infinite cycle based on response from platform
        td.patch({ insteonId: insteonId }, status);
      }
    });
}

var deviceKeepAlives = [];

function sendKeepAlives() {
  if (
    deviceKeepAlives.length == 0 &&
    td.deviceConf().devices &&
    td.deviceConf().devices.length > 0
  ) {
    td.deviceConf().devices.forEach(function (device) {
      deviceKeepAlives.push(device);
    });
    setTimeout(sendKeepAlives, 100);
  } else if (deviceKeepAlives.length > 0) {
    if (insteon.queue.length > 0) {
      setTimeout(sendKeepAlives, 5000);
    } else {
      var device = deviceKeepAlives[0];
      deviceKeepAlives.splice(0, 1);
      console.log("Sending device keepAlive");

      if (device.insteonId && device.deviceTypeUuid) {
        if (device.deviceTypeUuid == "fa1dc935-4ff4-4fc5-af86-301798502477") {
          // thermostat
          // reset the date
          insteon.thermostat(device.insteonId).date(function () {
            // then get status
            getThermostatStatus(device.insteonId);
          });
        } else {
          insteon.ping(device.insteonId, function () {
            console.log("Insteon device responded");
            console.log(device);
            device.isOnline = true;
            td.patch(device);
          });
        }
      }

      setTimeout(
        sendKeepAlives,
        deviceKeepAlives.length > 0 ? 5 * 1000 : 15 * 60 * 1000
      );
    }
  }
}

function switchLincHandler(device) {
  insteon
    .light(device.insteonId)
    .level()
    .then(function (level) {
      td.patch({
        deviceId: device.deviceId,
        insteonId: device.insteonId,
        load: level,
      });
    });
}

function setupDeviceEventHandlers(device) {
  console.log("setupDeviceEventHandlers");
  console.log(device);
  switch (device.deviceTypeUuid) {
    case "a3c3c96c-8da5-4909-b3df-938763c587f4": // Mini Remote - Switch
      insteon.light(device.insteonId).on("turnOn", function () {
        td.patch({
          deviceId: device.deviceId,
          insteonId: this.id,
          button: "on",
        });
      });
      insteon.light(device.insteonId).on("turnOff", function () {
        td.patch({
          deviceId: device.deviceId,
          insteonId: this.id,
          button: "off",
        });
      });
      break;
    case "0ad0d036-9f69-44c6-91bf-ad42a4cfb76f": // SwitchLinc
      insteon.light(device.insteonId).on("dimmed", function () {
        switchLincHandler(device);
      });
      insteon.light(device.insteonId).on("brightened", function () {
        switchLincHandler(device);
      });
      break;
  }
}

function registerDevice(link) {
  console.log("registerDevice : " + JSON.stringify(link));
  if (!link) return;

  if (linkData.deviceTypeUuid && link.id) {
    linkData.insteonId = link.id;
    linkData.hubId = td.deviceConf().deviceId;
    td.patch(linkData);
  }

  linkData = null;
}

function processThermostatAction(command) {
  // currently units, mode and fan cannot be changed from platform. These cause the current settings
  // to be echoed back to the platform.
  if (command.action.unit || command.action.mode || command.action.fan) {
    getThermostatStatus(command.device.insteonId);
  }

  if (command.device.unit == "F") {
    if (command.action.coolTempF) {
      insteon
        .thermostat(command.device.insteonId)
        .coolTemp(command.action.coolTempF);
    }
    if (command.action.heatTempF) {
      insteon
        .thermostat(command.device.insteonId)
        .heatTemp(command.action.heatTempF);
    }
  } else if (command.device.unit == "C") {
    if (command.action.coolTempC) {
      insteon
        .thermostat(command.device.insteonId)
        .coolTemp(command.action.coolTempC);
    }
    if (command.action.heatTempC) {
      insteon
        .thermostat(command.device.insteonId)
        .heatTemp(command.action.heatTempC);
    }
  }
}

function processCommandAction(command) {
  var device;

  if (td.deviceConf().devices) {
    device = td.deviceConf().devices.find(function (d) {
      return (
        d && d.deviceId && command.deviceId && d.deviceId == command.deviceId
      );
    });
  }
  switch (device.deviceTypeUuid) {
    case "0ad0d036-9f69-44c6-91bf-ad42a4cfb76f": // SwitchLinc
    case "7143f019-183b-42d4-b96e-9607149617d4": // LED Bulb
    case "ce274413-adb0-4e3c-8f22-65067ab8cda0": // LampLinc
      if (command.action.load) {
        insteon.light(device.insteonId).level(command.action.load);
      }
      break;
    case "fa1dc935-4ff4-4fc5-af86-301798502477": // Thermostat
      processThermostatAction(command);
      break;
  }
}

function isController(deviceTypeUuid) {
  switch (deviceTypeUuid) {
    case "ce274413-adb0-4e3c-8f22-65067ab8cda0": // LampLinc
    case "a3c3c96c-8da5-4909-b3df-938763c587f4": // Mini Remote - Switch
      return true;
  }
  return false;
}

function processPlatformMsg(command) {
  var arg = 0;

  if (command) {
    if (command.link) {
      linkData = command.link;
      insteon.cancelLinking(function () {
        console.log("cancelLinking done");
        console.log("linking: " + command.link.deviceTypeUuid);
        insteon.link(
          {
            controller: isController(command.link.deviceTypeUuid),
            group: 1,
            timeout: 30000,
          },
          function (error, link) {
            registerDevice(link);
          }
        );
      });
    } else if (
      command.deviceToken &&
      command.deviceId &&
      command.hubId &&
      command.deviceId != command.hubId &&
      command.hubId == td.deviceConf().deviceId
    ) {
      setupDeviceEventHandlers(command);

      if (command.deviceTypeUuid == "fa1dc935-4ff4-4fc5-af86-301798502477") {
        // Get Thermostat status after linking
        getThermostatStatus(command.insteonId);
      }
    } else if (command.device && command.device.insteonId) {
      if (command.delete) {
        insteon.unlink(
          command.device.insteonId,
          { controller: true, group: 1, unlink: true },
          function () {
            insteon.unlink(command.device.insteonId, {
              controller: false,
              group: 1,
              unlink: true,
            });
          }
        );
      }
    } else if (command.action) {
      processCommandAction(command);
    }
  }
}

function findHub() {
  var portName = "/dev/ttyUSB" + portNum.toString();
  debugOut("Attempting to open " + portName);

  td.lockPeripheral(portName, { wait: 10000 }, function (err) {
    if (err) {
      console.log("Unable to lock port " + portName);
      nextPort(true);
      return;
    }

    insteon.serial(portName, function () {
      debugOut("Connection opened");
      // Get gateway info
      insteon.info(function (error, info) {
        if (!info) {
          debugOut("Unable to find PLC on " + portName);
          insteon.close();
        } else {
          debugOut("info", info);
          td.on("message", function (data) {
            debugOut("Received from platform:");
            debugOut(data);
            if (data.devices) {
              data.devices.forEach(setupDeviceEventHandlers);
              sendKeepAlives();
            } else {
              processPlatformMsg(data);
            }
          });
          td.connect({
            name: "Insteon Gateway",
            deviceTypeUuid: "02bddde0-ab5d-4b3c-be6d-76bda65d986e",
          });
        }
      });
    });
  });
}

findHub();
