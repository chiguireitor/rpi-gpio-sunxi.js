var fs           = require('fs');
var util         = require('util');
var EventEmitter = require('events').EventEmitter;
var async        = require('async');
var debug        = require('debug')('rpi-gpio-sunxi');
var Epoll        = require('epoll').Epoll;

var PATH = '/sys/class/gpio_sw';
var PINS = {
    one: {
        // 1: 3.3v
        // 2: 5v
        //3:  SDA0,
        // 4: 5v
        //5':  SCK0,
        // 6: ground
        //7:  PWM,
        //8:  TX3,
        // 9: ground
        //10: RX3,
        //11: RX2,
        12: 'PD14',
        //13: TX2,
        // 14: ground
        //15: CTS2,
        16: 'PC4',
        // 17: 3.3v
        18: 'PC7',
        //19: MOSI,
        // 20: ground
        //21: MISO,
        //22: RTS2,
        //23: SCLK,
        //24: CS0,
        // 25: ground
        26: 'PA21',
        //27: SDA1,
        //28: SCK1,
        29: 'PA7',
        //30: ground
        31: 'PA8',
        //32
        33: 'PA9',
        //34
        35: 'PA10',
        //36
        37: 'PA20' // Not available it seems
        //38
        //39
        //40
    }
};

function Gpio() {
    var currentPins;
    var exportedInputPins = {};
    var exportedOutputPins = {};
    var getPinForCurrentMode = getPinOpi;
    var pollers = {};

    this.DIR_IN   = 'in';
    this.DIR_OUT  = 'out';

    this.MODE_OPI = 'mode_opi';

    this.EDGE_NONE    = 'none';
    this.EDGE_RISING  = 'rising';
    this.EDGE_FALLING = 'falling';
    this.EDGE_BOTH    = 'both';

    /**
     * Set pin reference mode. Defaults to 'mode_opi'.
     *
     * @param {string} mode Pin reference mode, 'mode_rpi' or 'mode_bcm'
     */
    this.setMode = function(mode) {
        if (mode !== this.MODE_OPI) {
            getPinForCurrentMode = getPinOpi;
            throw new Error('Cannot set invalid mode');
        }

        debug('setup pin mode to one')
        getPinForCurrentMode = getPinOpi;
    };

    /**
     * Setup a channel for use as an input or output
     *
     * @param {number}   channel   Reference to the pin in the current mode's schema
     * @param {string}   direction The pin direction, either 'in' or 'out'
     * @param edge       edge Informs the GPIO chip if it needs to generate interrupts. Either 'none', 'rising', 'falling' or 'both'. Defaults to 'none'
     * @param {function} onSetup   Optional callback
     */
    this.setup = function(channel, direction, edge, onSetup /*err*/) {
        debug('begin setup')
        if (arguments.length === 2 && typeof direction == 'function') {
            onSetup = direction;
            direction = this.DIR_OUT;
            edge = this.EDGE_NONE;
        } else if (arguments.length === 3 && typeof edge == 'function') {
            onSetup = edge;
            edge = this.EDGE_NONE;
        }
        
        debug('processed args ' + arguments.length)

        channel = parseInt(channel)
        direction = direction || this.DIR_OUT;
        edge = edge || this.EDGE_NONE;
        onSetup = onSetup || function() {};
        
        debug('got channel ' + channel)

        if (typeof channel !== 'number') {
            debug('channel !number')

            return process.nextTick(function() {
                onSetup(new Error('Channel must be a number'));
            });
        }

        if (direction !== this.DIR_IN && direction !== this.DIR_OUT) {
            debug('invalid direction')
            return process.nextTick(function() {
                onSetup(new Error('Cannot set invalid direction'));
            });
        }

        if ([
            this.EDGE_NONE,
            this.EDGE_RISING,
            this.EDGE_FALLING,
            this.EDGE_BOTH
        ].indexOf(edge) == -1) {
            return process.nextTick(function() {
                onSetup(new Error('Cannot set invalid edge'));
            });
        }

        var pinForSetup;
        debug('begin waterfall')
        async.waterfall([
            setRaspberryVersion,
            function(next) {
                debug('pinsetup')
                pinForSetup = getPinForCurrentMode(channel);
                if (!pinForSetup) {
                    return next(new Error('Channel ' + channel + ' does not map to a GPIO pin'));
                }
                debug('set up pin ' + pinForSetup);
                isExported(pinForSetup, next);
            },
            function(isExported, next) {
                debug('checkexport')
                if (isExported) {
                    return unexportPin(pinForSetup, next);
                }
                return next(null);
            },
            function(next) {
                debug('export')
                exportPin(pinForSetup, next);
            },
            function(next) {
                debug('setedge')
                setEdge(pinForSetup, edge, next);
            },
            function(next) {
                debug('direction')
                if (direction === this.DIR_IN) {
                    exportedInputPins[pinForSetup] = true;
                } else {
                    exportedOutputPins[pinForSetup] = true;
                }

                setDirection(pinForSetup, direction, next);
            }.bind(this),
            function(next) {
                debug('listen')
                listen(channel, function(readChannel) {
                    this.read(readChannel, function(err, value) {
                        if (err) {
                            debug(
                                'Error reading channel value after change, %d',
                                readChannel
                            );
                            return
                        }
                        debug('emitting change on channel %s with value %s', readChannel, value);
                        this.emit('change', readChannel, value);
                    }.bind(this));
                }.bind(this));
                next()
            }.bind(this)
        ], onSetup);
    };

    /**
     * Write a value to a channel
     *
     * @param {number}   channel The channel to write to
     * @param {boolean}  value   If true, turns the channel on, else turns off
     * @param {function} cb      Optional callback
     */
    this.write = this.output = function(channel, value, cb /*err*/) {
        var pin = getPinForCurrentMode(channel);
        debug('write ' + channel + ' -> ' + pin + ' <- ' + value)
        cb = cb || function() {}

        if (!exportedOutputPins[pin]) {
            debug('!exported')
            return process.nextTick(function() {
                cb(new Error('Pin has not been exported for write'));
            });
        }

        value = (!!value && value !== '0') ? '1' : '0';

        debug('writing pin %d with value %s', pin, value);
        fs.writeFile(PATH + '/' + pin + '/data', value, cb);
    };

    /**
     * Read a value from a channel
     *
     * @param {number}   channel The channel to read from
     * @param {function} cb      Callback which receives the channel's boolean value
     */
    this.read = this.input = function(channel, cb /*err,value*/) {
        if (typeof cb !== 'function') {
            throw new Error('A callback must be provided')
        }

        var pin = getPinForCurrentMode(channel);

        if (!exportedInputPins[pin] && !exportedOutputPins[pin]) {
            return process.nextTick(function() {
                cb(new Error('Pin has not been exported'));
            });
        }

        fs.readFile(PATH + '/' + pin + '/data', 'utf-8', function(err, data) {
            if (err) {
                return cb(err)
            }
            data = (data + '').trim() || '0';
            debug('read pin %s with value %s', pin, data);
            return cb(null, data === '1');
        });
    };

    /**
     * Unexport any pins setup by this module
     *
     * @param {function} cb Optional callback
     */
    this.destroy = function(cb) {
        var tasks = Object.keys(exportedOutputPins)
            .concat(Object.keys(exportedInputPins))
            .map(function(pin) {
                return function(done) {
                    removeListener(pin, pollers)
                    unexportPin(pin, done);
                }
            });

        async.parallel(tasks, cb);
    };

    /**
     * Reset the state of the module
     */
    this.reset = function() {
        exportedOutputPins = {};
        exportedInputPins = {};
        this.removeAllListeners();

        currentPins = undefined;
        getPinForCurrentMode = getPinOpi;
        pollers = {}
    };

    // Init
    EventEmitter.call(this);
    this.reset();


    // Private functions requring access to state
    function setRaspberryVersion(cb) {
        debug('set rbversion')
        if (currentPins) {
            debug('pins already setup')
            return cb(null);
        }

        currentPins = PINS.one;
        
        fs.readFile('/proc/cpuinfo', 'utf8', function(err, data) {
            if (err) return cb(err);

            // Match the last 4 digits of the number following "Revision:"
            var match = data.match(/Revision\s*:\s*[0-9a-f]*([0-9a-f]{4})/);
            var revisionNumber = parseInt(match[1], 16);
            var pinVersion = 'one'//(revisionNumber < 4) ? 'one' : 'v2';

            debug(
                'seen hardware revision %d; using pin mode %s',
                revisionNumber,
                pinVersion
            );

            currentPins = PINS[pinVersion];

            return cb(null);
        });
    };

    function getPinOpi(channel) {
        debug('getPinOpi ' + channel + ' -> ' + currentPins[channel])
        return currentPins[channel] + '';
    };

    function getPinBcm(channel) {
        channel = parseInt(channel, 10);
        return [
            12,
            16,
            18,
            26,
            29,
            31,
            33,
            35,
            37
        ].indexOf(channel) !== -1 ? (channel + '') : null;
    };

    /**
     * Listen for interrupts on a channel
     *
     * @param {number}      channel The channel to watch
     * @param {function}    cb Callback which receives the channel's err
     */
    function listen(channel, onChange) {
        var pin = getPinForCurrentMode(channel);

        if (!exportedInputPins[pin] && !exportedOutputPins[pin]) {
            throw new Error('Channel %d has not been exported', channel);
        }

        debug('listen for pin ' + pin);
        var poller = new Epoll(function(err, innerfd, events) {
            if (err) throw err
            clearInterrupt(innerfd);
            onChange(channel);
        });

        debug('openSync ' + PATH + '/' + pin);
        var fd = fs.openSync(PATH + '/' + pin + '/data', 'r+');
        clearInterrupt(fd);
        poller.add(fd, Epoll.EPOLLPRI);
        // Append ready-to-use remove function
        pollers[pin] = function() {
            poller.remove(fd).close();
        }
        debug('poller added');
    };
}
util.inherits(Gpio, EventEmitter);

function setEdge(pin, edge, cb) {
    debug('pin edge not supported yet');
    cb(null)
    /*debug('set edge %s on pin %d', edge.toUpperCase(), pin);
    fs.writeFile(PATH + '/gpio' + pin + '/edge', edge, function(err) {
        if (cb) return cb(err);
    });*/
}

function setDirection(pin, direction, cb) {
    debug('pin direction not supported yet');
    cb(null)
    /*debug('set direction %s on pin %d', direction.toUpperCase(), pin);
    fs.writeFile(PATH + '/gpio' + pin + '/direction', direction, function(err) {
        if (cb) return cb(err);
    });*/
}

function exportPin(pin, cb) {
    debug('no need to export');
    cb(null)
    /*fs.writeFile(PATH + '/export', pin, function(err) {
        if (cb) return cb(err);
    });*/
}

function unexportPin(pin, cb) {
    debug('no need to unexport')
    cb(null)
    /*debug('unexport pin %d', pin);
    fs.writeFile(PATH + '/unexport', pin, function(err) {
        if (cb) return cb(err);
    });*/
}

function isExported(pin, cb) {
    debug('asking if ' + pin + ' is exported')
    fs.exists(PATH + '/' + pin, function(exists) {
        debug('pin ' + pin + ' is exported')
        return cb(null, exists);
    });
}

function removeListener(pin, pollers) {
    if (!pollers[pin]) {
        return
    }
    debug('remove listener for pin %d', pin)
    pollers[pin]()
    delete pollers[pin]
}

function clearInterrupt(fd) {
    fs.readSync(fd, new Buffer(1), 0, 1, 0);
}

module.exports = new Gpio;
