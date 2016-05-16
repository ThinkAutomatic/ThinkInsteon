'use strict';
var td = require('thinkdevice');
var Insteon = require('home-controller').Insteon;
var insteon = new Insteon();

var portNum = 0;
var linkData = null;

function debugOut(label, message) {
  if (message) {
    if (message.constructor == Object) {
      console.log(label + ':' + JSON.stringify(message));
    }
    else {
      console.log(label + ':' + message.toString());
    }
  }
  else {
    console.log(label);
  }
}

function nextPort() {
  if (portNum >= 126) {
    debugOut('Unable to find PLC');
  }
  else {
    portNum++;
    findHub();
  }  
}

insteon.on('error', function(error) { nextPort(); });
insteon.on('close', function(error) { nextPort(); });

insteon.on('command', function(command) { 
//  debugOut('command', command);
});


function getThermostatStatus(insteonId) {
  // get status
  insteon.thermostat(insteonId).status().then( function(status) {
    console.log(status);
    if (status['unit'] == 'F' || status['unit'] == 'C') {
      status['coolTemp' + status['unit']] = status.setpoints.cool;
      status['heatTemp' + status['unit']] = status.setpoints.heat;
      status['fan'] = (status.fan ? 'on' : 'auto');
      status['silent'] = true;                      // this is to avoid infinite cycle based on response from platform
      td.patch({ insteonId: insteonId }, status);
    }
  });  
}

var deviceKeepAlives = [];

function sendKeepAlives() {
  if (deviceKeepAlives.length == 0 && td.deviceConf().devices && td.deviceConf().devices.length > 0) {
    td.deviceConf().devices.forEach(function (device) {
      deviceKeepAlives.push(device);
    });
    setTimeout(sendKeepAlives(), 100);
  }
  else if (deviceKeepAlives.length > 0) {
    if (insteon.queue.length > 0) {
      setTimeout(sendKeepAlives, 5000);    
    }
    else {
      var device = deviceKeepAlives[0];
      deviceKeepAlives.splice(0, 1);
      console.log('Sending device keepAlive');

      if (device.insteonId && device.deviceTypeUuid) {
        if (device.deviceTypeUuid == 'fc1f41be-8379-4d1a-890e-07ccdcf88a25') {  // thermostat
          // reset the date
          insteon.thermostat(device.insteonId).date( function() {
            // then get status
            getThermostatStatus(device.insteonId);
          });
        }
        else {
          insteon.ping(device.insteonId, function () {
            console.log(device.insteonId.toString() + ' responded');
            td.post('devices/' + device.deviceId.toString() + '/keepAlive');
          });
        }
      }

      setTimeout(sendKeepAlives, (deviceKeepAlives.length > 0 ? 5 * 1000 : 15 * 60 * 1000));
    }
  }
}

function switchLincHandler(insteonId) {
  insteon.light(insteonId).level().then(function (level) {
    td.patch({ insteonId: insteonId }, { load: level });  
  });
}

function setupDeviceEventHandlers(device) {
  switch (device.deviceTypeUuid) {
    case 'c2f54181-bb77-461e-9b98-01f6543cdeef':  // Mini Remote - Switch
      insteon.light(device['insteonId']).on('turnOn',     function () { td.patch({ insteonId: this.id }, { button: 'on' }); });
      insteon.light(device['insteonId']).on('turnOff',    function () { td.patch({ insteonId: this.id }, { button: 'off' }); });
      break;
    case 'ebe714be-ae82-4210-b1ed-bdda2ae52ea9':  // SwitchLinc
      insteon.light(device['insteonId']).on('dimmed',     function () { switchLincHandler(this.id); });
      insteon.light(device['insteonId']).on('brightened', function () { switchLincHandler(this.id); });
      break;
  }
}  

function registerDevice(link) {
  console.log('registerDevice : ' + link);
  if (!link)
    return;

  var deviceTypeUuid = linkData['deviceTypeUuid'];

  if (deviceTypeUuid && link['id']) {
    td.patch({ deviceTypeUuid: deviceTypeUuid, insteonId: link['id'].toUpperCase() }, linkData, function (device) {
      setupDeviceEventHandlers(device);

      if (deviceTypeUuid == 'fc1f41be-8379-4d1a-890e-07ccdcf88a25')  // Get Thermostat status after linking
        getThermostatStatus(link['id']);
    });
  }

  linkData = null;
}

function processThermostatAction(command) {
  // currently units, mode and fan cannot be changed from platform. These cause the current settings
  // to be echoed back to the platform.
  if (command['action']['unit'] || command['action']['mode'] || command['action']['fan'])       
                                        { getThermostatStatus(command['device']['insteonId']); }

  if (command['device']['unit'] == 'F') {
    if (command['action']['coolTempF']) { insteon.thermostat(command['device']['insteonId']).coolTemp(command['action']['coolTempF']); }    
    if (command['action']['heatTempF']) { insteon.thermostat(command['device']['insteonId']).heatTemp(command['action']['heatTempF']); }    
  }
  else if (command['device']['unit'] == 'C') {
    if (command['action']['coolTempC']) { insteon.thermostat(command['device']['insteonId']).coolTemp(command['action']['coolTempC']); }    
    if (command['action']['heatTempC']) { insteon.thermostat(command['device']['insteonId']).heatTemp(command['action']['heatTempC']); }    
  }  
}

function processCommandAction(command) {
  switch (command['device']['deviceTypeUuid']) {
    case 'ebe714be-ae82-4210-b1ed-bdda2ae52ea9':  // SwitchLinc
    case 'b02bf5e8-85f6-4f5b-b271-49a9afe71044':  // LED Bulb
    case 'c50c5dae-8fd2-461e-bfa3-547896317862':  // LampLinc
      if (command['action']['load']) { insteon.light(command['device']['insteonId']).level(command['action']['load']); }
      break;
    case 'fc1f41be-8379-4d1a-890e-07ccdcf88a25':  // Thermostat
      processThermostatAction(command);
      break;      
  }
}

function isController(deviceTypeUuid) {
  switch (deviceTypeUuid) {
    case 'c50c5dae-8fd2-461e-bfa3-547896317862':  // LampLinc
    case 'c2f54181-bb77-461e-9b98-01f6543cdeef':  // Mini Remote - Switch
      return true;
  }
  return false;
}

function processPlatformMsg(command) {
  var arg = 0;

  if (command) {
    debugOut(command);
    if (command['link']) {
      linkData = command['link'];
      insteon.cancelLinking(function() {
        insteon.link({ controller: isController(command['link']['deviceTypeUuid']), group: 1, timeout: 30000 }, function(error, link) {
          registerDevice(link);
        });
      });
    }
    else if (command['device'] && command['device']['insteonId']) {
      if (command['delete']) {
        insteon.unlink(command['device']['insteonId'], { controller: true, group: 1, unlink: true }, function() {
          insteon.unlink(command['device']['insteonId'], { controller: false, group: 1, unlink: true });
        });
      }
      else if (command['action']) {
        processCommandAction(command);
      }
    }    
  }
}


function findHub() {
  debugOut('Attempting to open /dev/ttyUSB' + portNum.toString());
  
  insteon.serial('/dev/ttyUSB' + portNum.toString(), function(){
    debugOut('Connection opened');
    // Get gateway info
    insteon.info(function(error, info) {
      if (!info) {
        debugOut('Unable to find PLC on /dev/ttyUSB' + portNum.toString());
        insteon.close();
      }
      else {
        debugOut('info', info);
        td.connect({ name: 'Insteon Gateway',  deviceTypeUuid: '636a0568-5dd1-414f-9328-a092164e5374' }, function () { 
          debugOut('Connected to platform');
          td.patch({ insteonId: info['id'] }, function (data) {
            debugOut('Response from platform:');
            debugOut(data);
            if (data['devices']) {
              data['devices'].forEach(setupDeviceEventHandlers);
            }
            sendKeepAlives();
          });

          td.on('message', function (data) {
//            debugOut('Received from platform:');
            processPlatformMsg(data);
          });          
        });      
      }
    });
  });
}

findHub();
