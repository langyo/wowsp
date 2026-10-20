#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "wows-depack.h"
#include "wows-depack-private.h"
#include "hashmap.h"

/* Hashmap helpers for the different hashmaps stored in the context) */

/* The metadata/file ids are only unique WITHIN one index file; the context
 * merges every index into shared maps, so the map keys are namespaced by the
 * owning WOWS_INDEX pointer. The comparators are proper three-way compares:
 * the previous `a > b` form reported 0 ("equal") for a < b as well, and the
 * probe sequences then resolved to wrong entries (wrong file contents on
 * extraction). */

/* metadata hashmap */
int metadata_compare(const void *a, const void *b, void *udata) {
    const WOWS_INDEX_METADATA_ENTRY *ma = *(WOWS_INDEX_METADATA_ENTRY **)a;
    const WOWS_INDEX_METADATA_ENTRY *mb = *(WOWS_INDEX_METADATA_ENTRY **)b;
    if (ma->owner_index != mb->owner_index)
        return ma->owner_index < mb->owner_index ? -1 : 1;
    return (ma->id > mb->id) - (ma->id < mb->id);
}

uint64_t metadata_hash(const void *item, uint64_t seed0, uint64_t seed1) {
    const WOWS_INDEX_METADATA_ENTRY *meta = *(WOWS_INDEX_METADATA_ENTRY **)item;
    return meta->id ^ ((uint64_t)(uintptr_t)meta->owner_index << 1);
}

/* file hashmap */
int file_compare(const void *a, const void *b, void *udata) {
    const WOWS_INDEX_DATA_FILE_ENTRY *fa = *(WOWS_INDEX_DATA_FILE_ENTRY **)a;
    const WOWS_INDEX_DATA_FILE_ENTRY *fb = *(WOWS_INDEX_DATA_FILE_ENTRY **)b;
    if (fa->owner_index != fb->owner_index)
        return fa->owner_index < fb->owner_index ? -1 : 1;
    return (fa->metadata_id > fb->metadata_id) - (fa->metadata_id < fb->metadata_id);
}

uint64_t file_hash(const void *item, uint64_t seed0, uint64_t seed1) {
    const WOWS_INDEX_DATA_FILE_ENTRY *file = *(WOWS_INDEX_DATA_FILE_ENTRY **)item;
    return file->metadata_id ^ ((uint64_t)(uintptr_t)file->owner_index << 1);
}

/* inode children hashmap */
int dir_inode_compare(const void *a, const void *b, void *udata) {
    const WOWS_BASE_INODE *ia = *(WOWS_BASE_INODE **)a;
    const WOWS_BASE_INODE *ib = *(WOWS_BASE_INODE **)b;
    return strcmp(ia->name, ib->name);
}

uint64_t dir_inode_hash(const void *item, uint64_t seed0, uint64_t seed1) {
    const WOWS_BASE_INODE *inode = *(WOWS_BASE_INODE **)item;
    return hashmap_sip(inode->name, strlen(inode->name), seed0, seed1);
}
