package attachments

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"relay.local/relay/internal/store"
	"relay.local/relay/internal/workspace"
)

const MaxBytes = 10 * 1024 * 1024

var Filename = regexp.MustCompile(`^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.(png|jpg|gif|webp)$`)
var reference = regexp.MustCompile(`/api/attachments/[a-f0-9-]{36}\.(?:png|jpg|gif|webp)`)

type Image struct {
	Type      string `json:"type"`
	Extension string `json:"extension"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	Size      int    `json:"size"`
	URL       string `json:"url,omitempty"`
}

func Inspect(data []byte, kind string) (Image, error) {
	extension := map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}[kind]
	if extension == "" || len(data) == 0 || len(data) > MaxBytes {
		return Image{}, errors.New("use PNG, JPEG, GIF or WebP images up to 10 MB")
	}
	width, height := 0, 0
	if kind != "image/webp" {
		config, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || "image/"+format != kind {
			return Image{}, errors.New("file does not match its image type")
		}
		width, height = config.Width, config.Height
	} else if len(data) >= 30 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP" && uint64(binary.LittleEndian.Uint32(data[4:8]))+8 == uint64(len(data)) {
		for offset := 12; offset+8 <= len(data); {
			name := string(data[offset : offset+4])
			size := int(binary.LittleEndian.Uint32(data[offset+4 : offset+8]))
			start := offset + 8
			if size > len(data)-start {
				break
			}
			chunk := data[start : start+size]
			if name == "VP8X" && size >= 10 {
				width = int(chunk[4]) | int(chunk[5])<<8 | int(chunk[6])<<16
				height = int(chunk[7]) | int(chunk[8])<<8 | int(chunk[9])<<16
				width++
				height++
				break
			}
			if name == "VP8L" && size >= 5 && chunk[0] == 0x2f {
				bits := binary.LittleEndian.Uint32(chunk[1:5])
				width = int(bits&0x3fff) + 1
				height = int((bits>>14)&0x3fff) + 1
				break
			}
			if name == "VP8 " && size >= 10 && chunk[0]&1 == 0 && bytes.Equal(chunk[3:6], []byte{0x9d, 1, 0x2a}) {
				width = int(binary.LittleEndian.Uint16(chunk[6:8]) & 0x3fff)
				height = int(binary.LittleEndian.Uint16(chunk[8:10]) & 0x3fff)
				break
			}
			offset = start + size + (size % 2)
		}
	}
	if width <= 0 || height <= 0 || width > 16000 || height > 16000 || int64(width)*int64(height) > 25000000 {
		return Image{}, errors.New("image dimensions must be valid and at most 25 megapixels")
	}
	return Image{Type: kind, Extension: extension, Width: width, Height: height, Size: len(data)}, nil
}
func Save(db *store.Store, data []byte, kind string) (Image, error) {
	info, err := Inspect(data, kind)
	if err != nil {
		return info, err
	}
	var id [16]byte
	if _, err = rand.Read(id[:]); err != nil {
		return info, err
	}
	id[6] = (id[6] & 15) | 64
	id[8] = (id[8] & 63) | 128
	h := hex.EncodeToString(id[:])
	name := h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:] + "." + info.Extension
	err = db.WithOwnership(func(root string, verify func() error) error {
		dir := filepath.Join(root, "attachments")
		if err := os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return err
		}
		stat, err := os.Lstat(dir)
		if err != nil || !stat.IsDir() || stat.Mode()&os.ModeSymlink != 0 {
			return errors.New("invalid attachment directory")
		}
		if err = verify(); err != nil {
			return err
		}
		file, err := os.OpenFile(filepath.Join(dir, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		_, writeErr := file.Write(data)
		err = errors.Join(writeErr, file.Sync(), file.Close())
		if err != nil {
			return err
		}
		after, err := os.Lstat(dir)
		if err != nil || !os.SameFile(stat, after) {
			return errors.New("attachment directory changed")
		}
		return verify()
	})
	if err == nil {
		info.URL = "/api/attachments/" + name
	}
	return info, err
}
func Read(db *store.Store, name string) ([]byte, Image, error) {
	if !Filename.MatchString(name) {
		return nil, Image{}, os.ErrNotExist
	}
	var data []byte
	var info Image
	err := db.WithOwnership(func(root string, verify func() error) error {
		var err error
		data, err = workspace.ReadPrivateFile(root, "attachments/"+name, MaxBytes)
		if err != nil {
			return err
		}
		kind := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}[filepath.Ext(name)]
		info, err = Inspect(data, kind)
		if err != nil {
			return err
		}
		return verify()
	})
	return data, info, err
}
func Context(db *store.Store, value map[string]any) ([]map[string]any, error) {
	raw, err := json.Marshal(map[string]any{"description": value["description"], "messages": value["messages"]})
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	result := []map[string]any{}
	for _, url := range reference.FindAllString(string(raw), -1) {
		if seen[url] {
			continue
		}
		seen[url] = true
		if len(result) >= 20 {
			return nil, errors.New("at most 20 local image attachments can be provided to a run")
		}
		name := strings.TrimPrefix(url, "/api/attachments/")
		_, info, err := Read(db, name)
		entry := map[string]any{"url": url}
		if err != nil {
			entry["error"] = "Local image is missing or invalid."
		} else {
			err = db.WithOwnership(func(root string, verify func() error) error {
				entry["path"] = filepath.Join(root, "attachments", name)
				return verify()
			})
			if err != nil {
				return nil, err
			}
			entry["type"], entry["width"], entry["height"] = info.Type, info.Width, info.Height
		}
		result = append(result, entry)
	}
	return result, nil
}
