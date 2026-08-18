package api

import (
	"encoding/json"
	"fmt"
	"os"
)

// The deployment and draft stores (ADR-0019, ADR-0021) both persist small JSON
// records as one file per key under a directory, with the same durability
// discipline. These helpers are that shared mechanism, so the atomic-write and
// directory-fsync logic lives in exactly one place.

// atomicWriteJSON marshals v and writes it to path atomically: temp file → fsync
// → rename → dir fsync. On return with nil error the record is durable, so a
// caller may treat it as saved (durable before visible, I2 / ADR-0005).
func atomicWriteJSON(dir, path string, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("sidecar: marshal: %w", err)
	}
	return atomicWriteFile(dir, path, data)
}

// atomicWriteFile writes raw bytes to path with the same discipline
// atomicWriteJSON gives a record. It exists because not every durable artifact is
// JSON — a process documentation PDF (ADR-0138) is opaque bytes stored beside its
// sidecar, and it deserves the same "nil error means on disk" guarantee.
func atomicWriteFile(dir, path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return fmt.Errorf("sidecar: open temp: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("sidecar: write: %w", err)
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(tmp)
		return fmt.Errorf("sidecar: sync temp: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("sidecar: close temp: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("sidecar: rename: %w", err)
	}
	return fsyncDir(dir)
}

// fsyncDir fsyncs a directory so a create/rename/remove of a file within it is
// itself durable.
func fsyncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("sidecar: open dir: %w", err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("sidecar: sync dir: %w", err)
	}
	return nil
}
