package room;

public enum Role {
    ADMIN, RECONSTRUCTOR, SPLAT_UPLOADER;

    public boolean canUploadCapture() { return this == ADMIN || this == RECONSTRUCTOR; }
}
