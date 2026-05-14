export class ObjectiveError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = "ObjectiveError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function assertCondition(condition, code, message, status = 400, details) {
  if (!condition) {
    throw new ObjectiveError(code, message, status, details);
  }
}
