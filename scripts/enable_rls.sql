do $$
declare
    tbl record;
begin
    for tbl in
        select table_name
        from information_schema.tables
        where table_schema = 'public'
          and table_type = 'BASE TABLE'
    loop
        execute format('alter table public.%I enable row level security;', tbl.table_name);
    end loop;
end$$;
