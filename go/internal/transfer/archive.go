// Package transfer provides bounded, portable state archives. Imports remain
// read-only history and cannot inherit approval, automation or live worktrees.
package transfer

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"relay.local/relay/internal/attachments"
	"relay.local/relay/internal/store"
	"relay.local/relay/internal/task"
	"relay.local/relay/internal/workspace"
)

const MaxBytes int64 = 512 * 1024 * 1024

type Manifest struct {
	Format    string            `json:"format"`
	Version   int               `json:"version"`
	CreatedAt string            `json:"createdAt"`
	Files     map[string]string `json:"files"`
}
type contextReader struct {
	ctx context.Context
	r   io.Reader
}
type limitedWriter struct {
	writer    io.Writer
	remaining int64
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, errors.New("state records exceed archive limit")
	}
	n, err := w.writer.Write(p)
	w.remaining -= int64(n)
	return n, err
}

func (c contextReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

func Export(ctx context.Context, db *store.Store, w io.Writer) error {
	return db.WithConfig(func(config store.ConfigSnapshot, _ func([]byte) error, verify func() error) error {
		data := config.Data
		if !config.Exists {
			data, _ = json.Marshal(task.Defaults())
		}
		root, err := db.OwnedRoot()
		if err != nil {
			return err
		}
		return export(ctx, root, data, w, func(w io.Writer) error { return db.ExportRecords(ctx, w) }, verify)
	})
}
func ExportLegacy(ctx context.Context, root string, w io.Writer) error {
	data, err := workspace.ReadPrivateFile(root, "config.json", 1024*1024)
	if errors.Is(err, os.ErrNotExist) {
		data, _ = json.Marshal(task.Defaults())
		err = nil
	}
	if err != nil {
		return err
	}
	return export(ctx, root, data, w, func(w io.Writer) error { return store.ExportLegacyRecords(ctx, root, w) }, func() error { return nil })
}
func export(ctx context.Context, root string, config []byte, w io.Writer, records func(io.Writer) error, verify func() error) error {
	dir, err := os.MkdirTemp("", "relay-export-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	file, err := os.OpenFile(filepath.Join(dir, "records.jsonl"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = records(&limitedWriter{writer: file, remaining: MaxBytes})
	closeErr := file.Close()
	if err = errors.Join(err, closeErr); err != nil {
		return err
	}
	if err = os.WriteFile(filepath.Join(dir, "config.json"), config, 0600); err != nil {
		return err
	}
	names := []string{"config.json", "records.jsonl"}
	entries, err := os.ReadDir(filepath.Join(root, "attachments"))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if len(entries) > 5000 {
		return errors.New("too many attachments to export")
	}
	for _, entry := range entries {
		if !attachments.Filename.MatchString(entry.Name()) {
			return errors.New("unexpected attachment entry")
		}
		names = append(names, "attachments/"+entry.Name())
	}
	compressed := gzip.NewWriter(w)
	archive := tar.NewWriter(compressed)
	manifest := Manifest{Format: "relay-state", Version: 1, CreatedAt: time.Now().UTC().Format(time.RFC3339), Files: map[string]string{}}
	total := int64(0)
	for _, name := range names {
		if err = ctx.Err(); err != nil {
			return err
		}
		path := filepath.Join(dir, name)
		if strings.HasPrefix(name, "attachments/") {
			data, e := workspace.ReadPrivateFile(root, name, attachments.MaxBytes)
			if e != nil {
				return e
			}
			if err = os.MkdirAll(filepath.Join(dir, "attachments"), 0700); err != nil {
				return err
			}
			if err = os.WriteFile(path, data, 0600); err != nil {
				return err
			}
		}
		input, e := os.Open(path)
		if e != nil {
			return e
		}
		info, e := input.Stat()
		if e != nil {
			input.Close()
			return e
		}
		total += info.Size()
		if total > MaxBytes-2*1024*1024-int64(len(names))*1024 {
			input.Close()
			return errors.New("archive exceeds 512 MB; archive older tasks separately")
		}
		if err = archive.WriteHeader(&tar.Header{Name: name, Mode: 0600, Size: info.Size(), Typeflag: tar.TypeReg}); err != nil {
			input.Close()
			return err
		}
		hash := sha256.New()
		_, err = io.Copy(io.MultiWriter(archive, hash), contextReader{ctx, input})
		input.Close()
		if err != nil {
			return err
		}
		manifest.Files[name] = hex.EncodeToString(hash.Sum(nil))
	}
	if err = verify(); err != nil {
		return err
	}
	raw, _ := json.Marshal(manifest)
	if err = archive.WriteHeader(&tar.Header{Name: "manifest.json", Mode: 0600, Size: int64(len(raw)), Typeflag: tar.TypeReg}); err != nil {
		return err
	}
	if _, err = archive.Write(raw); err != nil {
		return err
	}
	if err = archive.Close(); err != nil {
		return err
	}
	return compressed.Close()
}

// Restore installs into an absent directory by renaming a fully verified
// staging directory. Failures never alter an existing instance or destination.
func Restore(ctx context.Context, r io.Reader, destination string) error {
	destination, err := filepath.Abs(destination)
	if err != nil {
		return err
	}
	if _, err = os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		return errors.New("import destination must not exist")
	}
	parent := filepath.Dir(destination)
	if err = os.MkdirAll(parent, 0700); err != nil {
		return err
	}
	staging, err := os.MkdirTemp(parent, ".relay-import-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	compressed, err := gzip.NewReader(contextReader{ctx, r})
	if err != nil {
		return err
	}
	defer compressed.Close()
	compressed.Multistream(false)
	limited := &io.LimitedReader{R: compressed, N: MaxBytes + 1}
	archive := tar.NewReader(limited)
	digests := map[string]string{}
	manifest := Manifest{}
	total := int64(0)
	for count := 0; ; count++ {
		if count > 5003 {
			return errors.New("archive has too many entries")
		}
		header, e := archive.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			return e
		}
		name := header.Name
		valid := name == "manifest.json" || name == "config.json" || name == "records.jsonl" || strings.HasPrefix(name, "attachments/") && attachments.Filename.MatchString(strings.TrimPrefix(name, "attachments/"))
		if !valid || header.Typeflag != tar.TypeReg || header.Size < 0 || header.Size > MaxBytes || digests[name] != "" {
			return errors.New("invalid or duplicate archive entry")
		}
		total += header.Size
		if total > MaxBytes || limited.N <= 0 {
			return errors.New("archive exceeds 512 MB")
		}
		if strings.HasPrefix(name, "attachments/") && header.Size > attachments.MaxBytes {
			return errors.New("image exceeds limit")
		}
		if (name == "manifest.json" || name == "config.json") && header.Size > 1024*1024 {
			return errors.New("archive metadata exceeds limit")
		}
		path := filepath.Join(staging, name)
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		output, e := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if e != nil {
			return e
		}
		hash := sha256.New()
		_, err = io.Copy(io.MultiWriter(output, hash), contextReader{ctx, archive})
		closeErr := output.Close()
		if err = errors.Join(err, closeErr); err != nil {
			return err
		}
		digests[name] = hex.EncodeToString(hash.Sum(nil))
	}
	// Drain to validate gzip CRC/truncation and enforce the decompressed bound.
	if _, err = io.Copy(io.Discard, limited); err != nil {
		return err
	}
	if limited.N <= 0 {
		return errors.New("archive exceeds limit")
	}
	raw, err := os.ReadFile(filepath.Join(staging, "manifest.json"))
	if err != nil {
		return err
	}
	if json.Unmarshal(raw, &manifest) != nil || manifest.Format != "relay-state" || manifest.Version != 1 {
		return errors.New("unsupported Relay archive")
	}
	if digests["config.json"] == "" || digests["records.jsonl"] == "" || len(manifest.Files) != len(digests)-1 {
		return errors.New("archive file inventory is incomplete")
	}
	for name, digest := range manifest.Files {
		if name == "manifest.json" || digest == "" || digests[name] != digest {
			return errors.New("archive checksum mismatch")
		}
	}
	raw, err = os.ReadFile(filepath.Join(staging, "config.json"))
	if err != nil {
		return err
	}
	var config map[string]any
	if json.Unmarshal(raw, &config) != nil {
		return errors.New("invalid archived configuration")
	}
	config, err = task.ValidateConfig(config)
	if err != nil {
		return err
	}
	for _, provider := range []string{"codex", "claude", "pi"} {
		obj(obj(config["harnesses"])[provider])["enabled"] = false
	}
	state := filepath.Join(staging, "state")
	db, err := store.Open(state)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if !closed {
			db.Close()
		}
	}()
	input, err := os.Open(filepath.Join(staging, "records.jsonl"))
	if err != nil {
		return err
	}
	sanitizer := newSanitizer()
	err = db.ImportRecords(ctx, input, sanitizer.record)
	input.Close()
	if err != nil {
		return err
	}
	if err = sanitizer.legacyChats(db); err != nil {
		return err
	}
	service := task.ConfigurationService{Store: db}
	current, err := service.Read()
	if err != nil {
		return err
	}
	if _, err = service.Replace(current.Revision, config); err != nil {
		return err
	}
	if _, err = os.Stat(filepath.Join(staging, "attachments")); err == nil {
		for name := range digests {
			if !strings.HasPrefix(name, "attachments/") {
				continue
			}
			data, err := workspace.ReadPrivateFile(staging, name, attachments.MaxBytes)
			if err != nil {
				return err
			}
			kind := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}[filepath.Ext(name)]
			if _, err = attachments.Inspect(data, kind); err != nil {
				return err
			}
		}
		if err = os.Rename(filepath.Join(staging, "attachments"), filepath.Join(state, "attachments")); err != nil {
			return err
		}
	}
	if err = db.Close(); err != nil {
		return err
	}
	closed = true
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = installDirectory(state, destination); err != nil {
		return fmt.Errorf("install imported state: %w", err)
	}
	return nil
}
func obj(v any) map[string]any { m, _ := v.(map[string]any); return m }
func str(v any) string         { s, _ := v.(string); return s }
