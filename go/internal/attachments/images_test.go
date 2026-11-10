package attachments

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"relay.local/relay/internal/store"
	"testing"
)

func sample(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	pic := image.NewRGBA(image.Rect(0, 0, 2, 3))
	pic.Set(1, 1, color.White)
	if err := png.Encode(&out, pic); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
func TestImagesValidatePersistAndRefuseEscapes(t *testing.T) {
	db, err := store.Open(filepath.Join(t.TempDir(), "state"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	data := sample(t)
	pic, err := Save(db, data, "image/png")
	if err != nil {
		t.Fatal(err)
	}
	name := filepath.Base(pic.URL)
	got, info, err := Read(db, name)
	if err != nil || !bytes.Equal(got, data) || info.Width != 2 || info.Height != 3 {
		t.Fatalf("read: %#v %v", info, err)
	}
	for _, bad := range []string{"../secret", name + "/extra", "invalid.png"} {
		if _, _, err = Read(db, bad); err == nil {
			t.Fatal("unsafe name accepted")
		}
	}
	for _, kind := range []string{"image/jpeg", "image/svg+xml", "text/html"} {
		if _, err = Save(db, data, kind); err == nil {
			t.Fatal("incorrect MIME accepted")
		}
	}
	if _, err = Inspect([]byte("RIFFbrokenWEBP"), "image/webp"); err == nil {
		t.Fatal("broken WebP accepted")
	}
	if _, err = Inspect(make([]byte, MaxBytes+1), "image/png"); err == nil {
		t.Fatal("oversized upload accepted")
	}
	images, err := Context(db, map[string]any{"description": "![img](" + pic.URL + ")", "messages": []any{map[string]any{"text": pic.URL}}})
	if err != nil || len(images) != 1 || images[0]["path"] == nil {
		t.Fatalf("context: %#v %v", images, err)
	}
	if err = db.WithOwnership(func(root string, _ func() error) error {
		return os.Link(filepath.Join(root, "attachments", name), filepath.Join(root, "hardlink"))
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = Read(db, name); err == nil {
		t.Fatal("hardlink read accepted")
	}
	if err = db.WithOwnership(func(root string, _ func() error) error { return os.Remove(filepath.Join(root, "hardlink")) }); err != nil {
		t.Fatal(err)
	}

	if err = db.WithOwnership(func(root string, _ func() error) error {
		p := filepath.Join(root, "attachments", name)
		if err := os.Remove(p); err != nil {
			return err
		}
		return os.Symlink("/etc/hosts", p)
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = Read(db, name); err == nil {
		t.Fatal("symlink read accepted")
	}
}
