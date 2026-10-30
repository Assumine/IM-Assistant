"""Validate the active OpenCode application plan; never run native code or models."""
from pathlib import Path
import hashlib
import json
import re

from jsonschema import Draft202012Validator, FormatChecker

ROOT=Path(__file__).resolve().parents[1]


def validate(root=ROOT):
    root=Path(root).resolve()
    passed=[]
    def check(name,condition):
        if not condition:raise AssertionError(name)
        passed.append(name)
    def load(path):return json.loads((root/path).read_text(encoding='utf-8'))

    plan=load('docs/handoff/work-plan.json')
    progress=load('docs/handoff/progress.json')
    scope=load('docs/architecture/scope.json')
    baseline=load('docs/handoff/dependency-baseline.json')
    check('active plan is the OpenCode application rebase',
          plan['schema_version']==2 and plan['plan_id']=='opencode-app-base-v2' and
          plan['scope']=='opencode_application_rebase' and plan['integration_unit']=='modified_opencode_application')
    check('progress and scope belong to the active plan',progress['plan_id']==plan['plan_id']==scope['plan_id'])
    check('no competing host or conversation implementation',
          scope['base']=='OpenCode full application' and scope['parallel_python_host'] is False and
          scope['parallel_conversation_state_machine'] is False and scope['parallel_native_history_database'] is False)
    check('file capability removal preserves internal persistence',
          scope['filesystem']=={'project_tree':False,'project_file_tools':False,'general_shell_tools':False,
                               'internal_persistence':True,'controlled_attachments':True,'controlled_business_file_operations':True})
    check('planning does not switch production or migrate business data',
          scope['production_switch'] is False and scope['business_module_migration'] is False)
    check('old source remains a local read-only experience reference',scope['legacy_source_role']=='local_read_only_capability_and_regression_reference')
    check('source review is distinct from selected and built baseline',baseline['kind'] in {'source_review_not_selected_baseline','locked_source_baseline'})
    check('review records a concrete public source snapshot',baseline['upstream_repository']=='https://github.com/anomalyco/opencode' and bool(re.fullmatch('[0-9a-f]{40}',baseline['reviewed_commit'])))
    if baseline['selected_commit'] is not None:
        check('selected source has immutable commit and provenance',baseline['kind']=='locked_source_baseline' and bool(re.fullmatch('[0-9a-f]{40}',baseline['selected_commit'])) and bool(baseline['selected_tag']) and (root/'upstream/opencode.json').is_file())

    tasks=plan['tasks'];index={t['id']:t for t in tasks};states=progress['tasks']
    check('ten uniquely identified rebase tasks',len(tasks)==len(index)==10 and all(t['id'].startswith('R') for t in tasks))
    check('one active progress state per task',set(index)==set(states))
    check('next plan begins with source and unmodified baseline',plan['start_task']=='R0-01' and not index['R0-01']['depends_on'])
    check('all dependencies are real and non-self',all(d in index and d!=t['id'] for t in tasks for d in t['depends_on']))
    visited=set();visiting=set()
    def visit(ident):
        if ident in visiting:raise AssertionError('Task dependency cycle')
        if ident in visited:return
        visiting.add(ident)
        for dep in index[ident]['depends_on']:visit(dep)
        visiting.remove(ident);visited.add(ident)
    for ident in index:visit(ident)
    check('task dependency graph is acyclic',len(visited)==len(tasks))
    acceptance=(root/'docs/architecture/实施与验收.md').read_text(encoding='utf-8')
    ids=re.findall(r'- \[ \] (A\d{2})\b',acceptance)
    assigned=[case for task in tasks for case in task['acceptance_ids']]
    check('36 current acceptance requirements defined once',len(ids)==len(set(ids))==36)
    check('each acceptance requirement has one implementation owner',len(assigned)==len(set(assigned))==36 and set(assigned)==set(ids))
    check('acceptance document does not hold separate completion state','- [x]' not in acceptance.lower())
    recorded=[]
    for task in tasks:
        ident=task['id'];state=states[ident]
        check(ident+' defines outputs tests done criteria and real verification',
              bool(task['outputs']) and bool(task['test_files']) and len(task['done_when'])>=3 and
              'python tools/run_runtime_checks.py --task '+ident in task['verification_commands'] and bool(task['native_verification']))
        check(ident+' source targets remain in new implementation areas',all((root/p).resolve().is_relative_to(root) and p.split('/')[0] in {'opencode','modules','upstream','tests'} for p in task['outputs']+task['test_files']))
        check(ident+' uses a known task status',state['status'] in {'pending','in_progress','blocked','done'})
        if state['status']=='blocked':check(ident+' has a concrete blocker',bool(state['blocked_reason']))
        if state['status'] in {'in_progress','done'}:
            check(ident+' prerequisites completed',all(states[d]['status']=='done' for d in task['depends_on']))
            check('active work is explicitly recorded as started',progress['implementation_started'] is True)
        if state['status']=='done':
            if ident=='R0-01':
                check('completed native baseline was actually selected imported and built',baseline['selected_commit'] is not None and baseline['source_imported'] is True and baseline['native_build_verified'] is True)
            check(ident+' has actual source and tests',bool(state['artifacts']) and all((root/p).is_file() for p in state['artifacts']+task['test_files']))
            evidence=[v for v in state['verification'] if v.get('kind')=='runtime' and v.get('status')=='passed' and v.get('exit_code')==0 and v.get('tests_run',0)>0 and v.get('skipped',0)==0 and v.get('plan_id')==plan['plan_id']]
            check(ident+' has nonempty runtime evidence for this plan',bool(evidence))
            check(ident+' evidence covers its acceptance cases',set(task['acceptance_ids'])<={c for v in evidence for c in v.get('acceptance_ids',[])})
            recorded.extend(task['acceptance_ids'])
    check('only current task evidence advances current acceptance',set(recorded)==set(progress['runtime_acceptance_completed']) and len(recorded)==len(progress['runtime_acceptance_completed']))

    oldplan=load('docs/archive/python-host-plan/work-plan.json')
    oldprogress=load('docs/archive/python-host-plan/progress.json')
    check('superseded plan remains separately archived',len(oldplan['tasks'])==18 and plan['supersedes']=='docs/archive/python-host-plan/work-plan.json')
    olddone=[v for state in oldprogress['tasks'].values() for v in state['verification'] if state['status']=='done' and v.get('kind')=='runtime' and v.get('status')=='passed']
    check('old implementation evidence is preserved as historical',len(olddone)==4 and sum(v['tests_run'] for v in olddone)==49 and len(oldprogress['runtime_acceptance_completed'])==8)
    check('current tasks do not silently inherit historical completion',not any(ident.startswith('P') for ident in states))

    # Retained SDK artifacts are checked only as historical references.
    schemas={}
    for kind in ('module-manifest','backend-descriptor','backend-event'):
        schema=load('docs/architecture/contracts/'+kind+'.schema.json')
        Draft202012Validator.check_schema(schema)
        schemas[kind]=Draft202012Validator(schema,format_checker=FormatChecker())
        passed.append('historical '+kind+' schema is readable and structurally valid')
    examples={'module-manifest':'module-manifest','opencode-backend':'backend-descriptor','native-system-backend':'backend-descriptor'}
    for name,kind in examples.items():
        check('historical '+name+' example remains valid',schemas[kind].is_valid(load('docs/architecture/examples/'+name+'.json')))
    check('historical event examples remain valid',all(schemas['backend-event'].is_valid(e) for e in load('docs/architecture/examples/backend-events.json')))

    # Vendored upstream owns its own documentation/link conventions.
    documents=sorted({root/'README.md',root/'AGENTS.md',*[p for p in root.glob('*/README.md') if p.parent.name!='opencode'],*(root/'docs').rglob('*.md'),*(root/'tests').rglob('*.md')})
    for path in documents:
        content=path.read_text(encoding='utf-8')
        check(str(path.relative_to(root))+' readable UTF8 and balanced fences','\x00' not in content and '\ufffd' not in content and content.count('```')%2==0)
        for link in re.findall(r'\[[^\]]*\]\(([^)]+)\)',content):
            if link.startswith(('http://','https://','#')):continue
            target=(path.parent/link.split('#')[0]).resolve()
            check(str(path.relative_to(root))+' local link '+link,target.is_relative_to(root) and target.is_file())
    check('private reference config is ignored','/handoff.local.json' in (root/'.gitignore').read_text(encoding='utf-8').splitlines())
    example=load('handoff.local.example.json')
    check('portable reference example remains read-only',example['access']=='read_only' and not Path(example['legacy_root']).is_absolute())
    receipt={'status':'active_plan_validated','plan_id':plan['plan_id'],'count':len(passed),'checks':passed,
             'implementation_work_items':len(tasks),'planned_runtime_acceptance_count':len(ids),
             'runtime_acceptance_executed':0,'runtime_acceptance_recorded_completed':len(recorded),
             'archived_recorded_tests':49,'model_calls':0,'qq_calls':0,'production_deployments':0,
             'documents':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in documents}}
    output=root/'.reports/design-validation.json';output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(receipt,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    return receipt


if __name__=='__main__':
    result=validate()
    print(json.dumps({k:result[k] for k in ('status','plan_id','count','planned_runtime_acceptance_count','runtime_acceptance_executed','runtime_acceptance_recorded_completed','archived_recorded_tests')},ensure_ascii=False))
