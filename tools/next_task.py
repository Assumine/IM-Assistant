"""Read the handoff plan and local reference; never starts or modifies anything."""
from pathlib import Path
import argparse, json, sys

if __package__ in {None, ''}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tools.handoff_plan import select_plan

ROOT=Path(__file__).resolve().parents[1]

def local_reference(root=ROOT):
    p=root/'handoff.local.json'
    if not p.exists():return {'status':'not_configured','example':'handoff.local.example.json'}
    try:
        cfg=json.loads(p.read_text(encoding='utf-8'))
        if cfg.get('schema_version')!=1 or cfg.get('access')!='read_only':
            return {'status':'invalid_configuration','reason':'Only version 1 read_only references are supported'}
        legacy=(root/cfg['legacy_root']).resolve()
        client=(legacy/cfg['client_relative_root']).resolve()
        if not client.is_relative_to(legacy):return {'status':'invalid_configuration','reason':'Client root escapes the configured legacy root'}
        required=cfg['required_reference_files']
        if not isinstance(required,list) or not required or any(not isinstance(x,str) for x in required):
            return {'status':'invalid_configuration','reason':'Reference file list is missing or invalid'}
        paths=[(client/name).resolve() for name in required]
        if any(not path.is_relative_to(client) for path in paths):
            return {'status':'invalid_configuration','reason':'Reference file escapes the client directory'}
        missing=[name for name,path in zip(required,paths) if not path.is_file()]
        return {'status':'available_read_only' if not missing else 'reference_files_missing',
                'client_root':str(client),'missing':missing,'read_contents':False,'uploaded':False}
    except (OSError,ValueError,KeyError,TypeError) as error:
        return {'status':'invalid_configuration','reason':type(error).__name__}

def next_task(root=None):
    root=Path(ROOT if root is None else root)
    plan,progress=select_plan(root)
    states=progress['tasks'];items=plan['tasks']
    active=[t for t in items if states[t['id']]['status']=='in_progress']
    ready=[t for t in items if states[t['id']]['status']=='pending' and all(states[d]['status']=='done' for d in t['depends_on'])]
    chosen=(active or ready or [None])[0]
    blocked=[{'id':t['id'],'reason':states[t['id']].get('blocked_reason')} for t in items if states[t['id']]['status']=='blocked']
    return {'plan_id':plan.get('plan_id'),'status':'task_available' if chosen else 'blocked' if any(s['status']!='done' for s in states.values()) else 'all_tasks_recorded_done',
            'next_task':chosen,'completed_tasks':sum(s['status']=='done' for s in states.values()),
            'total_tasks':len(items),'blocked':blocked,'local_client_reference':local_reference(root),
            'note':'Read-only plan lookup. Recorded done status must still have real verification evidence.'}

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json',action='store_true',help='Return compact JSON')
    args=parser.parse_args()
    print(json.dumps(next_task(),ensure_ascii=False,indent=None if args.json else 2))
