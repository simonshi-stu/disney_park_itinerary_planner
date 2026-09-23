const sourceHealthColumns = [
  "source_health_id",
  "contract_version",
  "source_name",
  "run_id",
  "envelope_id",
  "source_status",
  "requested_at",
  "observed_at",
  "source_observed_at",
  "ingested_at",
  "source_age_minutes",
  "payload_sha256",
  "payload_byte_size",
  "record_count",
  "adapter_version",
  "schema_version",
  "error_type",
  "error_message",
  "fallback_status",
  "hosted_write_status",
  "hosted_failure_reason",
  "hosted_failure_message",
  "generated_at"
];

export function createPostgresSourceHealthRepository(client) {
  if (!client || typeof client.query !== "function") throw new TypeError("client must expose query()");
  return {
    async upsertSourceHealth(record) {
      const values = sourceHealthColumns.map((column) => record[column]);
      await client.query(
        `INSERT INTO ingestion.source_health (${sourceHealthColumns.join(",")})
         VALUES (${sourceHealthColumns.map((_, index) => `$${index + 1}`).join(",")})
         ON CONFLICT (source_name, run_id) DO UPDATE SET
           contract_version = EXCLUDED.contract_version,
           envelope_id = EXCLUDED.envelope_id,
           source_status = EXCLUDED.source_status,
           requested_at = EXCLUDED.requested_at,
           observed_at = EXCLUDED.observed_at,
           source_observed_at = EXCLUDED.source_observed_at,
           ingested_at = EXCLUDED.ingested_at,
           source_age_minutes = EXCLUDED.source_age_minutes,
           payload_sha256 = EXCLUDED.payload_sha256,
           payload_byte_size = EXCLUDED.payload_byte_size,
           record_count = EXCLUDED.record_count,
           adapter_version = EXCLUDED.adapter_version,
           schema_version = EXCLUDED.schema_version,
           error_type = EXCLUDED.error_type,
           error_message = EXCLUDED.error_message,
           fallback_status = EXCLUDED.fallback_status,
           hosted_write_status = EXCLUDED.hosted_write_status,
           hosted_failure_reason = EXCLUDED.hosted_failure_reason,
           hosted_failure_message = EXCLUDED.hosted_failure_message,
           generated_at = EXCLUDED.generated_at,
           updated_at = now()`,
        values
      );
      return record;
    }
  };
}
