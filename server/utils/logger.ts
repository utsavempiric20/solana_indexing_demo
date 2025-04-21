import { createLogger, format, transports } from "winston";
const { combine, timestamp, printf, colorize, label } = format;

export const createCustomLogger = (component: string) => {
  const logFormat = printf(({ level, message, label, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : "";
    return `${timestamp} [${label}] ${level}: ${message} ${metaStr}`;
  });

  return createLogger({
    format: combine(
      label({ label: component }),
      timestamp(),
      colorize(),
      logFormat
    ),
    transports: [
      new transports.Console({
        level: process.env.NODE_ENV === "development" ? "debug" : "info",
      }),
      new transports.File({
        filename: "logs/error.log",
        level: "error",
      }),
      new transports.File({
        filename: "logs/combined.log",
        level: "info",
      }),
    ],
  });
};
