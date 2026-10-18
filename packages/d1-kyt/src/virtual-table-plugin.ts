import type { KyselyPlugin, OperationNode, PluginTransformQueryArgs, PluginTransformResultArgs, QueryResult, RootOperationNode, UnknownRow } from 'kysely';
import {
  AliasNode,
  AndNode,
  BinaryOperationNode,
  ColumnNode,
  DeleteQueryNode,
  FromNode,
  IdentifierNode,
  InsertQueryNode,
  JoinNode,
  OnNode,
  OperationNodeTransformer,
  OperatorNode,
  ReferenceNode,
  SelectAllNode,
  SelectionNode,
  SelectQueryNode,
  TableNode,
  UpdateQueryNode,
  ValueNode,
  WhereNode,
} from 'kysely';
import type { VirtualTable, VirtualTableJoin } from './schema.js';

interface VtRef {
  vtName: string;
  vt: VirtualTable<any, any>;
  /** Alias the virtual table was referenced under, e.g. `selectFrom('X as p')`. */
  alias?: string;
}

class VirtualTableTransformer extends OperationNodeTransformer {
  constructor(private readonly vts: Map<string, VirtualTable<any, any>>) {
    super();
  }

  protected override transformSelectQuery(node: SelectQueryNode): SelectQueryNode {
    if (!node.from) return super.transformSelectQuery(node);

    let ref: VtRef | undefined;
    for (const from of node.from.froms) {
      ref = this.matchVt(from);
      if (ref) break;
    }

    if (!ref) return super.transformSelectQuery(node);
    const { vt } = ref;
    const primaryRef = ref.alias ?? vt._source._name;

    const newFroms = node.from.froms.map(f =>
      this.matchVt(f) ? this.buildPrimaryFrom(vt, ref!.alias) : f,
    );

    const joinNodes = vt._joins.map((j: VirtualTableJoin<any, any>) => this.buildJoin(j, primaryRef));
    const newJoins = [...joinNodes, ...(node.joins ?? [])];

    let newWhere = node.where;
    if (vt._where) {
      const vtWhereNode = this.buildWhere(vt._where, primaryRef);
      newWhere = node.where
        ? WhereNode.cloneWithOperation(node.where, 'And', vtWhereNode.where)
        : vtWhereNode;
    }

    let newSelections = node.selections;
    if (node.selections?.some(s => SelectAllNode.is(s.selection))) {
      newSelections = this.buildSelectAll(vt, primaryRef);
    }

    return super.transformSelectQuery({
      ...node,
      from: FromNode.create(newFroms),
      joins: newJoins.length > 0 ? newJoins : node.joins,
      where: newWhere,
      selections: newSelections,
    });
  }

  protected override transformInsertQuery(node: InsertQueryNode): InsertQueryNode {
    if (node.into && this.vts.has(node.into.table.identifier.name)) {
      throw new Error(`Cannot insert into virtual table "${node.into.table.identifier.name}"`);
    }
    return super.transformInsertQuery(node);
  }

  protected override transformUpdateQuery(node: UpdateQueryNode): UpdateQueryNode {
    if (node.table && TableNode.is(node.table) && this.vts.has(node.table.table.identifier.name)) {
      throw new Error(`Cannot update virtual table "${node.table.table.identifier.name}"`);
    }
    return super.transformUpdateQuery(node);
  }

  protected override transformDeleteQuery(node: DeleteQueryNode): DeleteQueryNode {
    for (const from of node.from.froms) {
      if (TableNode.is(from) && this.vts.has(from.table.identifier.name)) {
        throw new Error(`Cannot delete from virtual table "${from.table.identifier.name}"`);
      }
    }
    return super.transformDeleteQuery(node);
  }

  private matchVt(node: OperationNode): VtRef | undefined {
    if (TableNode.is(node) && this.vts.has(node.table.identifier.name)) {
      const vtName = node.table.identifier.name;
      return { vtName, vt: this.vts.get(vtName)! };
    }
    if (AliasNode.is(node) && TableNode.is(node.node) && this.vts.has(node.node.table.identifier.name)) {
      const vtName = node.node.table.identifier.name;
      const alias = IdentifierNode.is(node.alias) ? node.alias.name : undefined;
      return { vtName, vt: this.vts.get(vtName)!, alias };
    }
    return undefined;
  }

  private buildPrimaryFrom(vt: VirtualTable<any, any>, alias: string | undefined): OperationNode {
    const table = TableNode.create(vt._source._name);
    return alias ? AliasNode.create(table, IdentifierNode.create(alias)) : table;
  }

  private buildJoin(join: VirtualTableJoin<any, any>, primaryRef: string): JoinNode {
    const [primaryCol, joinedCol] = join.on;
    const on = BinaryOperationNode.create(
      ReferenceNode.create(ColumnNode.create(primaryCol), TableNode.create(primaryRef)),
      OperatorNode.create('='),
      ReferenceNode.create(ColumnNode.create(joinedCol), TableNode.create(join.table._name)),
    );
    const joinType = join.type === 'left' ? 'LeftJoin' : 'InnerJoin';
    return JoinNode.createWithOn(joinType, TableNode.create(join.table._name), OnNode.create(on));
  }

  private buildWhere(filter: Record<string, unknown>, primaryRef: string): WhereNode {
    const conditions = Object.entries(filter).map(([col, val]) =>
      BinaryOperationNode.create(
        ReferenceNode.create(ColumnNode.create(col), TableNode.create(primaryRef)),
        OperatorNode.create('='),
        ValueNode.create(val),
      ),
    );
    const combined = (conditions as OperationNode[]).reduce((left, right) => AndNode.create(left, right));
    return WhereNode.create(combined);
  }

  private buildSelectAll(vt: VirtualTable<any, any>, primaryRef: string): SelectionNode[] {
    const joinedCols = new Set<string>(vt._joins.flatMap((j: VirtualTableJoin<any, any>) => j.columns as string[]));
    const ownCols = [...this.autoColumns(vt), ...Object.keys(vt._columns).filter(c => !joinedCols.has(c))];

    const ownSelections = ownCols.map(col =>
      SelectionNode.create(ReferenceNode.create(ColumnNode.create(col), TableNode.create(primaryRef))),
    );
    const joinedSelections = vt._joins.flatMap((j: VirtualTableJoin<any, any>) =>
      (j.columns as string[]).map(col =>
        SelectionNode.create(ReferenceNode.create(ColumnNode.create(col), TableNode.create(j.table._name))),
      ),
    );

    return [...ownSelections, ...joinedSelections];
  }

  private autoColumns(vt: VirtualTable<any, any>): string[] {
    const o = vt._options as Record<string, unknown>;
    const cols: string[] = [];
    if (o['primaryKey'] !== false) cols.push((o['primaryKeyColumn'] as string | undefined) ?? 'id');
    if (o['createdAt'] !== false) cols.push((o['createdAtColumn'] as string | undefined) ?? 'createdAt');
    if (o['updatedAt'] !== false) cols.push((o['updatedAtColumn'] as string | undefined) ?? 'updatedAt');
    return cols;
  }
}

export class VirtualTablePlugin implements KyselyPlugin {
  private readonly transformer: VirtualTableTransformer;

  constructor(virtualTables: VirtualTable<any, any>[]) {
    const map = new Map(virtualTables.map(vt => [vt._name, vt]));
    this.transformer = new VirtualTableTransformer(map);
  }

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node);
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
