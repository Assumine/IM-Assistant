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

for p in OUT.rglob('*.md'):
    text=p.read_text(encoding='utf-8')
    check(p.name+' readable UTF8 and balanced code fences','\x00' not in text and '\ufffd' not in text and text.count('```')%2==0)
    for link in re.findall(r'\[[^\]]*\]\(([^)]+)\)',text):
        if link.startswith(('http://','https://','#')):continue
        relative=link.split('#')[0]
        target=(p.parent/relative).resolve()
        if target==OUT/'design-validation.json' and not target.exists():
            generated_links.append(target);continue
        check(p.name+' local link '+relative,target.is_relative_to(OUT.resolve()) and target.is_file())

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

REPORT.parent.mkdir(parents=True,exist_ok=True)
receipt={'status':'design_files_validated','checks':passed,'count':len(passed),
         'planned_runtime_acceptance_count':66,'runtime_acceptance_executed':0,
         'schemas':3,'examples':4,'model_calls':0,'qq_calls':0,'production_deployments':0,
         'write_scope':str(OUT),'whole_backend_integration':True,'business_migration':False,
         'documents':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in OUT.glob('*.md')}}
REPORT.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
for target in generated_links:check('generated validation receipt link exists',target.is_file())
receipt['count']=len(passed)
REPORT.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:receipt[k] for k in ['status','count','planned_runtime_acceptance_count','runtime_acceptance_executed','model_calls','production_deployments']},ensure_ascii=False))
