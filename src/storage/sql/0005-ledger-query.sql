ALTER TABLE bills ADD COLUMN category_id TEXT GENERATED ALWAYS AS (CASE WHEN json_type(raw,'$.cateid')='text' THEN json_extract(raw,'$.cateid') ELSE raw -> '$.cateid' END) VIRTUAL;
ALTER TABLE bills ADD COLUMN member_id TEXT GENERATED ALWAYS AS (CASE WHEN json_type(raw,'$.userid')='text' THEN json_extract(raw,'$.userid') ELSE raw -> '$.userid' END) VIRTUAL;
ALTER TABLE bills ADD COLUMN asset_id TEXT GENERATED ALWAYS AS (CASE WHEN json_type(raw,'$.assetid')='text' THEN json_extract(raw,'$.assetid') ELSE raw -> '$.assetid' END) VIRTUAL;
ALTER TABLE bills ADD COLUMN from_id TEXT GENERATED ALWAYS AS (CASE WHEN json_type(raw,'$.fromid')='text' THEN json_extract(raw,'$.fromid') ELSE raw -> '$.fromid' END) VIRTUAL;
ALTER TABLE bills ADD COLUMN target_id TEXT GENERATED ALWAYS AS (CASE WHEN json_type(raw,'$.targetid')='text' THEN json_extract(raw,'$.targetid') ELSE raw -> '$.targetid' END) VIRTUAL;
ALTER TABLE bills ADD COLUMN pack_id TEXT GENERATED ALWAYS AS (CASE WHEN json_type(raw,'$.packid')='text' THEN json_extract(raw,'$.packid') ELSE raw -> '$.packid' END) VIRTUAL;
ALTER TABLE bills ADD COLUMN remark_text TEXT GENERATED ALWAYS AS (COALESCE(json_extract(raw,'$.remark'),'')) VIRTUAL;
ALTER TABLE bills ADD COLUMN source_text TEXT GENERATED ALWAYS AS (COALESCE(json_extract(raw,'$.fromact'),'') || ' ' || COALESCE(json_extract(raw,'$.targetact'),'') || ' ' || COALESCE(json_extract(raw,'$.descinfo'),'')) VIRTUAL;
ALTER TABLE bills ADD COLUMN platform_code INTEGER GENERATED ALWAYS AS (COALESCE(json_extract(raw,'$.platform'),0)) VIRTUAL;
ALTER TABLE bills ADD COLUMN status_code INTEGER GENERATED ALWAYS AS (COALESCE(json_extract(raw,'$.status'),1)) VIRTUAL;
ALTER TABLE bills ADD COLUMN extra_json TEXT GENERATED ALWAYS AS (
  CASE json_type(raw,'$.extra') WHEN 'object' THEN raw -> '$.extra'
    WHEN 'text' THEN CASE WHEN json_valid(json_extract(raw,'$.extra')) THEN json_extract(raw,'$.extra') ELSE '{}' END
    ELSE '{}' END
) VIRTUAL;
ALTER TABLE bills ADD COLUMN id_sort_key TEXT GENERATED ALWAYS AS (
  CASE WHEN id<>'' AND id NOT GLOB '*[^0-9]*' AND (id='0' OR substr(id,1,1)<>'0')
    THEN printf('1%06d:',length(id)) || id ELSE '0:' || id END
) VIRTUAL;
CREATE INDEX bills_stable_time ON bills(uid,dataset_id,time_sec,id_sort_key);
CREATE INDEX bills_member_time ON bills(uid,dataset_id,member_id,time_sec,id_sort_key);
CREATE INDEX bills_category_time ON bills(uid,dataset_id,category_id,time_sec,id_sort_key);
CREATE INDEX bills_type_time ON bills(uid,dataset_id,type,time_sec,id_sort_key);
CREATE INDEX bills_pack_time ON bills(uid,dataset_id,pack_id,time_sec,id_sort_key);
