CREATE FUNCTION room_reserve_job_outputs(p_job uuid,p_lease uuid,p_objects jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
 v_owner text;
 v_job room_jobs%ROWTYPE;
 v_limit bigint;
 v_used numeric;
 v_new numeric:=0;
 v_total numeric:=0;
 v_entry record;
 v_old room_storage_allocations%ROWTYPE;
 v_size bigint;
BEGIN
 IF p_objects IS NULL OR jsonb_typeof(p_objects)<>'object' OR p_objects='{}'::jsonb THEN
  RAISE EXCEPTION 'Output allocation must be a nonempty object map' USING ERRCODE='22023';
 END IF;
 FOR v_entry IN SELECT key,value FROM jsonb_each(p_objects) LOOP
  IF length(v_entry.key)>1024 OR v_entry.key NOT LIKE 'outputs/'||p_job::text||'/%'
   OR v_entry.key ~ '[[:cntrl:]]' OR jsonb_typeof(v_entry.value)<>'number'
   OR v_entry.value::text !~ '^[0-9]+$' OR length(v_entry.value::text)>19 THEN
   RAISE EXCEPTION 'Invalid output key or byte length' USING ERRCODE='22023';
  END IF;
  BEGIN v_size:=v_entry.value::text::bigint;
  EXCEPTION WHEN numeric_value_out_of_range THEN
   RAISE EXCEPTION 'Output byte length is too large' USING ERRCODE='22023';
  END;
  IF v_size<1 THEN RAISE EXCEPTION 'Output byte length must be positive' USING ERRCODE='22023'; END IF;
  v_total:=v_total+v_size;
 END LOOP;
 IF v_total>2147483648 THEN RAISE EXCEPTION 'Output batch exceeds 2 GiB' USING ERRCODE='22023'; END IF;
 SELECT owner INTO v_owner FROM room_jobs WHERE id=p_job;
 IF NOT FOUND THEN RETURN 'LEASE_LOST'; END IF;
 INSERT INTO room_quota_owners(owner) VALUES(v_owner) ON CONFLICT DO NOTHING;
 PERFORM 1 FROM room_quota_owners WHERE owner=v_owner FOR UPDATE;
 SELECT * INTO v_job FROM room_jobs WHERE id=p_job FOR UPDATE;
 IF NOT FOUND OR p_lease IS NULL OR v_job.lease_token IS NULL OR v_job.owner<>v_owner OR v_job.state<>'RUNNING' OR v_job.cancel_requested
  OR v_job.lease_token IS DISTINCT FROM p_lease OR v_job.lease_until IS NULL OR v_job.lease_until<=clock_timestamp() THEN
  RETURN 'LEASE_LOST';
 END IF;
 IF NOT (SELECT initialized FROM room_quota_owners WHERE owner=v_owner) THEN RETURN 'QUOTA_EXCEEDED'; END IF;
 SELECT COALESCE(o.storage_limit_bytes,d.storage_limit_bytes) INTO v_limit
  FROM room_quota_owners o CROSS JOIN room_quota_defaults d WHERE o.owner=v_owner AND d.id=1;
 FOR v_entry IN SELECT key,value FROM jsonb_each(p_objects) LOOP
  v_size:=v_entry.value::text::bigint;
  SELECT * INTO v_old FROM room_storage_allocations WHERE object_key=v_entry.key;
  IF FOUND THEN
   IF v_old.owner<>v_owner OR v_old.resource_kind<>'job' OR v_old.resource_id<>p_job
    OR v_old.maximum_bytes<>v_size OR v_old.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'Output allocation identity differs' USING ERRCODE='22023';
   END IF;
  ELSE v_new:=v_new+v_size;
  END IF;
 END LOOP;
 SELECT COALESCE(sum(maximum_bytes),0) INTO v_used FROM room_storage_allocations WHERE owner=v_owner AND released_at IS NULL;
 IF v_new>0 AND v_used+v_new>v_limit THEN RETURN 'QUOTA_EXCEEDED'; END IF;
 FOR v_entry IN SELECT key,value FROM jsonb_each(p_objects) LOOP
  INSERT INTO room_storage_allocations(object_key,owner,resource_kind,resource_id,maximum_bytes)
   VALUES(v_entry.key,v_owner,'job',p_job,v_entry.value::text::bigint) ON CONFLICT DO NOTHING;
 END LOOP;
 RETURN 'RESERVED';
END;
$$;
