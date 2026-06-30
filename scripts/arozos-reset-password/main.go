// One-shot ArozOS password reset for solo self-host recovery over SSH.
// ArozOS stores passhash/<username> in system/ao.db (Bolt) as JSON-encoded sha512 hex.
package main

import (
	"crypto/sha512"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"

	bolt "go.etcd.io/bbolt"
)

func main() {
	dbPath := flag.String("db", "", "path to system/ao.db")
	user := flag.String("user", "", "ArozOS username")
	password := flag.String("password", "", "new login password")
	flag.Parse()

	if *dbPath == "" || *user == "" || *password == "" {
		flag.Usage()
		os.Exit(2)
	}

	sum := sha512.Sum512([]byte(*password))
	hashed := hex.EncodeToString(sum[:])
	value, err := json.Marshal(hashed)
	if err != nil {
		log.Fatal(err)
	}

	db, err := bolt.Open(*dbPath, 0o600, nil)
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
		return bucket.Put(key, value)
	})
	if err != nil {
		log.Fatal(err)
	}

	fmt.Printf("Password updated for %q\n", *user)
}
