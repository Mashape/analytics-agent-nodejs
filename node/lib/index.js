var url         = require('url');
var util        = require('util');
var async       = require('async');
var io          = require('socket.io-client');
var debug       = require('debug')('apianalytics');

var helpers     = require('./helpers');
var pkg         = require('../package.json');

module.exports = function Agent (serviceToken, options) {
  // Ensure agent key exists
  if (!serviceToken) {
    throw new Error('a service token is required, visit: https://www.apianalytics.com/ to obtain one');
  }

  // Ensure instance type
  if (!(this instanceof Agent)) {
    return new Agent(serviceToken, options);
  }

  // this alias
  var self = this;

  // Setup options with defaults
  self.opts = Object.create({
    host: 'socket.apianalytics.com:80',
    logger: debug,
    sendBody: false,
    batch: 1
  });

  // assign new values or keep old ones
  Object.keys(options).map(function (key) {
    key in self.opts && (self.opts[key] = options[key]);
  });

  // Setup event queue
  // TODO specify worker pool
  // TODO use msgpack + gzip?
  this.queue = async.queue(function (entry, done) {
    self.har.entries.push(entry);

    if (self.har.entries.length >= self.opts.batch) {
      // TODO benchmark this
      self.socket.send(JSON.parse(JSON.stringify(self.har)));

      // reset entries object
      self.har.entries = [];

      self.opts.logger(util.format.apply(null, [
        'Recorded %s %s request with a response of %s %s',
        entry.request.method,
        entry.request.url,
        entry.response.status,
        entry.response.statusText
      ]));
    }

    done();
  });

  // init HAR object
  this.har = {
    version: '1.2',
    serviceToken: serviceToken,
    creator: {
      name: pkg.name,
      version: pkg.version
    },

    entries: []
  };

  // Pause event queue until connected to Analytics server
  this.queue.pause();

  // Connect to Analytics server
  this.socket = io(util.format('ws://%s', this.opts.host));

  this.socket.on('connect', function () {
    self.opts.logger(util.format('Connected using token: %s', serviceToken));
    self.queue.resume();
  });

  this.socket.on('disconnect', function () {
    self.opts.logger('Disconnected');
    self.queue.pause();
  });

  // API Recorder Middleware
  // TODO use tamper or tamper-esque method to get raw body
  //      to determine raw content size to get infer compression size
  return function (req, res, next) {
    var agentResStartTime = new Date();

    var chunked = [];

    var original = {
      end: res.end,
      write: res.write
    };

    // override node's http.ServerResponse.write method
    res.write = function (chunk, encoding) {
      // call the original http.ServerResponse.write method
      original.write.call(res, chunk, encoding);

      chunked.push(chunk);
    };

    // override node's http.ServerResponse.end method
    res.end = function (data, encoding) {
      // call the original http.ServerResponse.end method
      original.end.call(res, data, encoding);

      if (chunked.length) {
        data = Buffer.concat(chunked);
      }

      // construct body
      var base64Body = data ? data.toString('utf8') : null;
      var originalBodySize = data ? data.length : -1;

      var reqReceived = new Date();
      var resHeaders = helpers.parseResponseHeaderString(res._header);
      var resBodySize = parseInt(helpers.getHeaderValue(resHeaders.headersArr, 'content-length', originalBodySize));
      var waitTime = agentResStartTime.getTime() - reqReceived.getTime();
      var protocol = req.connection.encrypted ? 'https' : 'http';
      var reqHeadersArr = helpers.objectToArray(req.headers);

      var entry = {
        serverIPAddress: helpers.getServerAddress(),
        startedDateTime: agentResStartTime.toISOString(),
        request: {
          method: req.method,
          url: util.format('%s://%s%s', protocol, req.headers.host, req.url),
          httpVersion: 'HTTP/' + req.httpVersion,
          queryString: helpers.objectToArray(url.parse(req.url, true).query),
          headers: reqHeadersArr,
          headersSize: helpers.getReqHeaderSize(req),
          bodySize: helpers.getHeaderValue(reqHeadersArr, 'content-length', -1)
        },

        response: {
          status: res.statusCode,
          statusText: resHeaders.statusText,
          httpVersion: resHeaders.version,
          headers: resHeaders.headersArr,
          redirectUrl: helpers.getHeaderValue(resHeaders.headersArr, 'location', ''),
          headersSize: res._header ? new Buffer(res._header).length : -1,
          bodySize: resBodySize,
          content: {
            // TODO measure before compression, if any
            size: resBodySize,
            mimeType: helpers.getHeaderValue(resHeaders.headersArr, 'content-type', 'application/octet-stream'),
            text: self.opts.sendBody ? base64Body : null
          }
        },

        cache: {},
        timings: {
          send: 0, // TODO
          wait: waitTime,
          receive: 0  // TODO
        }
      };

      // log some info
      self.opts.logger(util.format.apply(null, [
        'Detected \033[32mfinish\033[39m with %s response on request, %s %s',
        res.statusCode,
        entry.request.method,
        entry.request.url
      ]));

      // send to queue
      self.queue.push(entry);
    };

    if (typeof next === 'function') {
      next();
    }
  };
};
