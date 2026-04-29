const pino = require('pino');
const config = require('./config');

const baseOptions = {
  level: config.logLevel,
  base: { service: 'meowarr' },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.basic_auth_password'],
    censor: '[REDACTED]',
  },
};

const transport = config.isProduction
  ? undefined
  : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' } };

const logger = pino(transport ? { ...baseOptions, transport } : baseOptions);

module.exports = logger;
