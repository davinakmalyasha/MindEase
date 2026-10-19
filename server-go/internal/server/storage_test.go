package server

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestSaveUploadFallsBackToDisk(t *testing.T) {
	for _, key := range []string{"S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"} {
		t.Setenv(key, "")
	}
	s := testServer()
	s.Cfg.UploadDir = t.TempDir()

	url, err := s.saveUpload(context.Background(), "file.png", []byte("payload"))
	if err != nil {
		t.Fatalf("saveUpload: %v", err)
	}
	if url != "/uploads/file.png" {
		t.Fatalf("url = %q; want /uploads/file.png", url)
	}
	data, err := os.ReadFile(filepath.Join(s.Cfg.UploadDir, "file.png"))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(data) != "payload" {
		t.Fatalf("stored bytes = %q", data)
	}
}
