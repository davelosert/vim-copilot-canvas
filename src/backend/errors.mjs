export class EditorError extends Error {
    constructor(code, message, status = 409) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
