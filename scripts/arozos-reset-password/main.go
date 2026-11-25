// One-shot ArozOS password reset for solo self-host recovery over SSH
// and fleet set_aroz_password (precomputed hash from the control plane).
// ArozOS stores passhash/<username> in system/ao.db (Bolt) as JSON-encoded sha512 hex.
// Rotating auth/sessionkey in the same transaction invalidates existing desktop cookies.
package main

import (
	"crypto/rand"
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

func isSha512Hex(s string) bool {
	if len(s) != 128 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') {
			continue
		}
		return false
	}
	return true
}

func main() {
	dbPath := flag.String("db", "", "path to system/ao.db")
	user := flag.String("user", "", "ArozOS username")
	password := flag.String("password", "", "new login password (SSH recovery)")
	hashFlag := flag.String("hash", "", "precomputed sha512 hex (128 chars); preferred for fleet")
	flag.Parse()

	if *dbPath == "" || *user == "" {
		flag.Usage()
		os.Exit(2)
	}

	// AO_PW_HASH keeps the hash out of the process list (single-container mode, change sandbox-box-commands).
	hashed := strings.ToLower(strings.TrimSpace(*hashFlag))
	if hashed == "" {
		hashed = strings.ToLower(strings.TrimSpace(os.Getenv("AO_PW_HASH")))
	}
	if hashed == "" {
		if *password == "" {
			fmt.Fprintln(os.Stderr, "either -password or -hash is required")
			flag.Usage()
			os.Exit(2)
		}
		sum := sha512.Sum512([]byte(*password))
		hashed = hex.EncodeToString(sum[:])
	}
	if !isSha512Hex(hashed) {
		log.Fatal("hash must be 128 lowercase hex characters (sha512)")
	}

	value, err := json.Marshal(hashed)
	if err != nil {
		log.Fatal(err)
	}

	sessionRaw := make([]byte, 32)
	if _, err := rand.Read(sessionRaw); err != nil {
		log.Fatal(err)
	}
	sessionValue, err := json.Marshal(string(sessionRaw))
	if err != nil {
		log.Fatal(err)
	}

	// A running ArozOS holds the lock of ao.db. Fail after 10 seconds instead of waiting forever.
	db, err := bolt.Open(*dbPath, 0o600, &bolt.Options{Timeout: 10 * time.Second})
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	err = db.Update(func(tx *bolt.Tx) error {
		bucket, err := tx.CreateBucketIfNotExists([]byte("auth"))
		if err != nil {
			return err
		}
		key := []byte("passhash/" + *user)
		if bucket.Get(key) == nil {
			return fmt.Errorf("user %q not found (missing passhash/%s in ao.db)", *user, *user)
		}
		if err := bucket.Put(key, value); err != nil {
			return err
		}
		return bucket.Put([]byte("sessionkey"), sessionValue)
	})
	if err != nil {
		log.Fatal(err)
	}

	fmt.Printf("Password updated for %q (session key rotated)\n", *user)
}
