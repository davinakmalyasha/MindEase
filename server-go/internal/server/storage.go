package server

import (
	"bytes"
	"context"
	"mime"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// storageConfigured mirrors lib/storage.ts: all four S3 variables must be set
// before the S3 branch is used. Anything less falls back to the local disk,
// which is the documented single-container deployment.
func storageConfigured() bool {
	for _, name := range []string{"S3_ENDPOINT", "S3_BUCKET", "S3_ACCESS_KEY", "S3_SECRET_KEY"} {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			return false
		}
	}
	return true
}

// saveUpload writes one file and returns the URL a client can fetch it from:
// `/uploads/<name>` on the local disk, or the configured public base URL on S3
// (R2/MinIO work through the same path-style client).
func (s *Server) saveUpload(ctx context.Context, name string, data []byte) (string, error) {
	if !storageConfigured() {
		if err := os.MkdirAll(s.Cfg.UploadDir, 0o755); err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(s.Cfg.UploadDir, name), data, 0o644); err != nil {
			return "", err
		}
		return "/uploads/" + name, nil
	}

	endpoint := strings.TrimSpace(os.Getenv("S3_ENDPOINT"))
	bucket := strings.TrimSpace(os.Getenv("S3_BUCKET"))
	region := strings.TrimSpace(os.Getenv("S3_REGION"))
	if region == "" {
		// R2 and several S3-compatible stores use "auto"; the SDK still needs a
		// non-empty value to sign a request.
		region = "auto"
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), "")),
	)
	if err != nil {
		return "", err
	}
	client := s3.NewFromConfig(cfg, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(endpoint)
		options.UsePathStyle = true
	})
	contentType := mime.TypeByExtension(filepath.Ext(name))
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	if _, err := client.PutObject(ctx, &s3.PutObjectInput{
		Bucket:      aws.String(bucket),
		Key:         aws.String(name),
		Body:        bytes.NewReader(data),
		ContentType: aws.String(contentType),
	}); err != nil {
		return "", err
	}

	base := strings.TrimSpace(os.Getenv("S3_PUBLIC_URL"))
	if base == "" {
		base = strings.TrimRight(endpoint, "/") + "/" + bucket
	}
	return strings.TrimRight(base, "/") + "/" + url.PathEscape(name), nil
}
