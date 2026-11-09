package workspace

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"sync"
)

var ErrWorkspaceBusy = errors.New("workspace is already reserved")
var ErrInvalidLease = errors.New("workspace lease is no longer valid")

type Registry struct {
	mu     sync.Mutex
	owners map[string]string
}
type Lease struct {
	mu           sync.RWMutex
	registry     *Registry
	token, owner string
	roots        []string
	identities   []os.FileInfo
	released     bool
}

func NewRegistry() *Registry { return &Registry{owners: map[string]string{}} }
func normalizeRoots(paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, errors.New("workspace roots are required")
	}
	roots := make([]string, 0, len(paths))
	for _, path := range paths {
		if !filepath.IsAbs(path) {
			return nil, errors.New("workspace root must be absolute")
		}
		root, err := filepath.EvalSymlinks(path)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(root)
		if err != nil {
			return nil, err
		}
		if !info.IsDir() {
			return nil, errors.New("workspace root must be a directory")
		}
		roots = append(roots, root)
	}
	sort.Strings(roots)
	for i := range roots {
		for j := 0; j < i; j++ {
			overlap, err := overlaps(roots[i], roots[j])
			if err != nil {
				return nil, err
			}
			if overlap {
				return nil, errors.New("workspace roots overlap")
			}
		}
	}
	return roots, nil
}

// Compare physical ancestors as well as paths, so case or symlink aliases do
// not allow concurrent writers on the same checkout.
func overlaps(a, b string) (bool, error) {
	infoA, err := os.Stat(a)
	if err != nil {
		return false, err
	}
	infoB, err := os.Stat(b)
	if err != nil {
		return false, err
	}
	if os.SameFile(infoA, infoB) {
		return true, nil
	}
	ancestor := func(path string, target os.FileInfo) (bool, error) {
		for {
			parent := filepath.Dir(path)
			if parent == path {
				return false, nil
			}
			info, err := os.Stat(parent)
			if err != nil {
				return false, err
			}
			if os.SameFile(info, target) {
				return true, nil
			}
			path = parent
		}
	}
	first, err := ancestor(a, infoB)
	if err != nil || first {
		return first, err
	}
	return ancestor(b, infoA)
}

// Acquire reserves all roots atomically. Existing leases always win, even if
// the requested owner is the same task; a caller must reuse its existing lease.
func (r *Registry) Acquire(owner string, paths []string) (*Lease, error) {
	if r == nil || owner == "" {
		return nil, errors.New("workspace owner is required")
	}
	roots, err := normalizeRoots(paths)
	if err != nil {
		return nil, err
	}
	bytes := make([]byte, 32)
	if _, err = rand.Read(bytes); err != nil {
		return nil, err
	}
	token := hex.EncodeToString(bytes)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.owners == nil {
		r.owners = map[string]string{}
	}
	for _, root := range roots {
		for held := range r.owners {
			overlap, err := overlaps(root, held)
			if err != nil {
				return nil, err
			}
			if overlap {
				return nil, ErrWorkspaceBusy
			}
		}
	}
	identities := make([]os.FileInfo, len(roots))
	for i, root := range roots {
		info, err := os.Stat(root)
		if err != nil {
			return nil, err
		}
		identities[i] = info
	}
	for _, root := range roots {
		r.owners[root] = token
	}
	return &Lease{registry: r, token: token, owner: owner, roots: roots, identities: identities}, nil
}

// Protect prevents release until fn completes. Revalidate must be called after
// inspection and immediately before committing a decision.
func (l *Lease) Protect(owner string, paths []string, fn func(revalidate func() error) error) error {
	if l == nil || fn == nil {
		return ErrInvalidLease
	}
	l.mu.RLock()
	defer l.mu.RUnlock()
	if l.released || l.owner != owner {
		return ErrInvalidLease
	}
	verify := func() error {
		roots, err := normalizeRoots(paths)
		if err != nil {
			return err
		}
		if len(roots) != len(l.roots) {
			return ErrInvalidLease
		}
		matched := make([]bool, len(l.identities))
		for _, root := range roots {
			current, err := os.Stat(root)
			if err != nil {
				return err
			}
			found := false
			for i, identity := range l.identities {
				if !matched[i] && os.SameFile(current, identity) {
					matched[i] = true
					found = true
					break
				}
			}
			if !found {
				return ErrInvalidLease
			}
		}
		l.registry.mu.Lock()
		defer l.registry.mu.Unlock()
		for _, root := range l.roots {
			if l.registry.owners[root] != l.token {
				return ErrInvalidLease
			}
		}
		return nil
	}
	if err := verify(); err != nil {
		return err
	}
	return fn(verify)
}

// WithHeld holds a validated lease for an operation that does not commit a decision.
func (l *Lease) WithHeld(owner string, paths []string, fn func() error) error {
	if fn == nil {
		return ErrInvalidLease
	}
	return l.Protect(owner, paths, func(_ func() error) error { return fn() })
}
func (l *Lease) Release() {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.released {
		return
	}
	l.registry.mu.Lock()
	for _, root := range l.roots {
		if l.registry.owners[root] == l.token {
			delete(l.registry.owners, root)
		}
	}
	l.registry.mu.Unlock()
	l.released = true
}
