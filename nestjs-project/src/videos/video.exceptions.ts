import { DomainException } from '../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoTooLargeException extends DomainException {
  constructor() {
    super('VIDEO_TOO_LARGE', 413, 'Video exceeds the maximum upload size');
  }
}

export class VideoUploadNotInProgressException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_NOT_IN_PROGRESS',
      409,
      'Video upload is not in progress',
    );
  }
}

export class InvalidUploadPartsException extends DomainException {
  constructor() {
    super(
      'INVALID_UPLOAD_PARTS',
      400,
      'Uploaded parts are invalid or incomplete',
    );
  }
}

export class UploadSizeMismatchException extends DomainException {
  constructor() {
    super(
      'UPLOAD_SIZE_MISMATCH',
      422,
      'Uploaded size does not match the declared size',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}

export class InvalidPartNumbersException extends DomainException {
  constructor() {
    super('VALIDATION_ERROR', 400, 'part_numbers must not exceed part_count');
  }
}
