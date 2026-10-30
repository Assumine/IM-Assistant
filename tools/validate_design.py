"""Validate only the design package; does not execute any backend or model."""
from pathlib import Path
import copy, hashlib, json, re
from jsonschema import Draft202012Validator, FormatChecker

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/architecture'
REPORT=ROOT/'.reports/design-validation.json'
passed=[]
def check(name, value):
    if not value:raise AssertionError(name)
    passed.append(name)
def load(name):return json.loads((OUT/name).read_text(encoding='utf-8'))

validators={};generated_links=[]
for name in ['module-manifest','backend-descriptor','backend-event']:
    value=load('contracts/'+name+'.schema.json')
    Draft202012Validator.check_schema(value)
    validators[name]=Draft202012Validator(value,format_checker=FormatChecker())
    passed.append(name+' Draft202012 schema valid')

def validates(kind, data):return not list(validators[kind].iter_errors(data))

manifest=load('examples/module-manifest.json')
backend=load('examples/opencode-backend.json')
native=load('examples/native-system-backend.json')
events=load('examples/backend-events.json')
check('whole-package example validates',validates('module-manifest',manifest))
check('OpenCode whole-backend example validates',validates('backend-descriptor',backend))
check('native-system whole-backend example validates',validates('backend-descriptor',native))
check('all public event examples validate',all(validates('backend-event',e) for e in events))
check('example final result precedes completion',
      next(e['sequence'] for e in events if e['type']=='message.committed') < next(e['sequence'] for e in events if e['type']=='run.completed'))
check('example queue acceptance has no fabricated run ID',events[0]['native_run_id'] is None and events[0]['payload']['execution_state']=='queued')
check('example source identities unique',len({(e['backend_instance_id'],e['stream_id'],e['event_id']) for e in events})==len(events))
check('example event order strictly increasing',[e['sequence'] for e in events]==list(range(1,len(events)+1)))

bad=copy.deepcopy(backend);bad['ownership']['compaction']='host'
check('split host-owned compactor rejected',not validates('backend-descriptor',bad))
bad=copy.deepcopy(backend);bad['ownership']['queue']='host'
check('competing host queue ownership rejected',not validates('backend-descriptor',bad))
bad=copy.deepcopy(backend);bad['methods'].remove('context.compact')
check('advertised compact without implementation method rejected',not validates('backend-descriptor',bad))
bad=copy.deepcopy(backend);bad['methods'].remove('inputs.lookup')
check('missing result reconciliation method rejected',not validates('backend-descriptor',bad))
bad=copy.deepcopy(backend);bad['capabilities']['queue_reorder']=True;bad['capabilities']['queue_inspect']=False;bad['methods'].append('queue.reorder')
check('reorder without queue snapshot rejected',not validates('backend-descriptor',bad))
bad=copy.deepcopy(manifest);bad['backend_descriptor']='../outside.json'
check('relative traversal in manifest reference rejected',not validates('module-manifest',bad))
bad=copy.deepcopy(manifest);bad['runtime']['endpoint']='http://127.0.0.1:1234/'
check('managed command and external endpoint mixture rejected',not validates('module-manifest',bad))
bad=copy.deepcopy(events[-1]);bad['native_run_id']=None
check('completion without exact native run rejected',not validates('backend-event',bad))
bad=copy.deepcopy(events[0]);bad['sequence']=0
check('nonpositive sequence rejected',not validates('backend-event',bad))
bad=copy.deepcopy(events[0]);bad['request_id']=None
check('input acceptance without source request rejected',not validates('backend-event',bad))
future=copy.deepcopy(native);future['extensions']={'example.optional_future':{'supported':True}}
check('unknown namespaced optional declaration accepted structurally',validates('backend-descriptor',future))

documents=sorted(set([ROOT/'README.md',ROOT/'AGENTS.md',*ROOT.glob('*/README.md'),
                      *(ROOT/'docs').rglob('*.md'),*(ROOT/'tests').rglob('*.md')]))
for p in documents:
    text=p.read_text(encoding='utf-8')
    check(p.name+' readable UTF8 and balanced code fences','\x00' not in text and '\ufffd' not in text and text.count('```')%2==0)
    for link in re.findall(r'\[[^\]]*\]\(([^)]+)\)',text):
        if link.startswith(('http://','https://','#')):continue
        relative=link.split('#')[0]
        target=(p.parent/relative).resolve()
        if target==OUT/'design-validation.json' and not target.exists():
            generated_links.append(target);continue
        check(str(p.relative_to(ROOT))+' local link '+relative,target.is_relative_to(ROOT.resolve()) and target.is_file())

scope=load('scope.json')
check('foundation-only scope explicit',not scope['production_switch'] and not scope['business_module_migration'])
check('integration unit is the whole backend',scope['unit_of_integration']=='complete_conversation_backend' and not scope['separate_context_or_compactor_plugins_required'])
check('queue authority stays in whole backend',scope['queue_authority']=='owning_conversation_backend')
check('legacy evidence references are marked as documentation only',scope['source_evidence_scope']=='legacy_workspace_reference_only')
steps=(OUT/'实施与验收.md').read_text(encoding='utf-8')
ids=re.findall(r'(?:- \[ \] |\| )([FHOUR]\d{2})(?: |\b)',steps)
check('66 unique future runtime acceptance cases enumerated',len(ids)==66 and len(set(ids))==66)
check('no future runtime acceptance is marked completed','- [x]' not in steps.lower())
check('SDK baseline is declared as a future reference, not an installed package','2.1.4' in scope['reference_backend'])

plan=json.loads((ROOT/'docs/handoff/work-plan.json').read_text(encoding='utf-8'))
progress=json.loads((ROOT/'docs/handoff/progress.json').read_text(encoding='utf-8'))
tasks=plan['tasks'];index={t['id']:t for t in tasks};states=progress['tasks']
check('18 unique implementation work items defined',len(tasks)==18 and len(index)==18)
check('handoff keeps whole-backend foundation scope',plan['scope']=='foundation_only' and plan['integration_unit']=='complete_conversation_backend')
check('progress has exactly one state per work item',set(index)==set(states))
check('initial implementation starts at P0-01',plan['start_task']=='P0-01' and not index['P0-01']['depends_on'])
check('all task dependencies refer to existing different tasks',all(d in index and d!=t['id'] for t in tasks for d in t['depends_on']))
visited=set();visiting=set()
def visit(ident):
    if ident in visiting:raise AssertionError('Task dependency cycle: '+ident)
    if ident in visited:return
    visiting.add(ident)
    for dep in index[ident]['depends_on']:visit(dep)
    visiting.remove(ident);visited.add(ident)
for ident in index:visit(ident)
check('work item graph is acyclic',len(visited)==18)
assigned=[case for t in tasks for case in t['acceptance_ids']]
check('all 66 acceptance cases have exactly one primary implementation owner',len(assigned)==66 and len(set(assigned))==66 and set(assigned)==set(ids))
for t in tasks:
    check(t['id']+' defines outputs tests commands and completion criteria',
          bool(t['outputs']) and bool(t['test_files']) and len(t['done_when'])>=3 and
          f"python tools/run_runtime_checks.py --task {t['id']}" in t['verification_commands'])
    paths=t['outputs']+t['test_files']
    check(t['id']+' planned targets stay inside repository source areas',
          all((ROOT/p).resolve().is_relative_to(ROOT.resolve()) and p.split('/')[0] in
              {'sdk','host','conversation','modules','portal_adapter','tests'} for p in paths))
check('progress status values recognized',all(s['status'] in {'pending','in_progress','blocked','done'} for s in states.values()))
recorded=[]
for ident,s in states.items():
    if s['status']=='in_progress':check(ident+' active dependencies completed',all(states[d]['status']=='done' for d in index[ident]['depends_on']))
    if s['status']=='blocked':check(ident+' records a concrete blocker',isinstance(s['blocked_reason'],str) and bool(s['blocked_reason'].strip()))
    if s['status']!='done':continue
    check(ident+' dependencies completed',all(states[d]['status']=='done' for d in index[ident]['depends_on']))
    check(ident+' has actual source/test artifacts',bool(s['artifacts']) and all((ROOT/p).is_file() for p in s['artifacts']) and all((ROOT/p).is_file() for p in index[ident]['test_files']))
    verified=[v for v in s['verification'] if v.get('kind')=='runtime' and v.get('status')=='passed' and v.get('exit_code')==0 and v.get('tests_run',0)>0]
    check(ident+' has nonzero runtime verification evidence',bool(verified))
    cases={case for v in verified for case in v.get('acceptance_ids',[])}
    check(ident+' evidence covers assigned acceptance cases',set(index[ident]['acceptance_ids'])<=cases)
    recorded.extend(index[ident]['acceptance_ids'])
check('global acceptance progress agrees with completed work items',set(progress['runtime_acceptance_completed'])==set(recorded) and len(progress['runtime_acceptance_completed'])==len(set(recorded)))
if any(s['status'] in {'in_progress','done'} for s in states.values()):
    check('implementation start flag reflects actual recorded work',progress['implementation_started'] is True)
check('local-only client configuration is ignored', '/handoff.local.json' in (ROOT/'.gitignore').read_text(encoding='utf-8').splitlines())
local_example=json.loads((ROOT/'handoff.local.example.json').read_text(encoding='utf-8'))
check('portable local reference example is read-only and not personal',local_example['schema_version']==1 and local_example['access']=='read_only' and not Path(local_example['legacy_root']).is_absolute())
baseline=json.loads((ROOT/'docs/handoff/dependency-baseline.json').read_text(encoding='utf-8'))
check('dependency evidence explicitly remains historical',baseline['kind']=='historical_reference_only' and baseline['opencode']['installed_in_this_repository'] is False)
check('reference dependency records contain version integrity and public origin',len(baseline['opencode']['packages'])==3 and all(p['version']=='2.1.4' and p['integrity'].startswith('sha512-') and p['resolved'].startswith('https://registry.npmjs.org/') for p in baseline['opencode']['packages']))

REPORT.parent.mkdir(parents=True,exist_ok=True)
receipt={'status':'design_files_validated','checks':passed,'count':len(passed),
         'planned_runtime_acceptance_count':66,'runtime_acceptance_executed':0,
         'schemas':3,'examples':4,'model_calls':0,'qq_calls':0,'production_deployments':0,
         'write_scope':str(OUT),'whole_backend_integration':True,'business_migration':False,
         'implementation_work_items':18,'runtime_acceptance_recorded_completed':len(recorded),
         'documents':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in documents}}
REPORT.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for target in generated_links:check('generated validation receipt link exists',target.is_file())
receipt['count']=len(passed)
REPORT.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:receipt[k] for k in ['status','count','planned_runtime_acceptance_count','runtime_acceptance_executed','model_calls','production_deployments']},ensure_ascii=False))
