export abstract class StorageException extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class StorageInvalidPartsException extends StorageException {
  constructor(cause?: unknown) {
    super('Uploaded parts are invalid or incomplete', cause);
  }
}

export class StorageObjectNotFoundException extends StorageException {
  constructor(key: string, cause?: unknown) {
    super(`Object not found: ${key}`, cause);
  }
}
