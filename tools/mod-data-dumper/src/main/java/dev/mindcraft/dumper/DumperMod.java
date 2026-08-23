package dev.mindcraft.dumper;

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.SharedConstants;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.tags.BlockTags;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.ai.attributes.DefaultAttributes;
import net.minecraft.world.item.DiggerItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.ShearsItem;
import net.minecraft.world.item.SwordItem;
import net.minecraft.world.item.crafting.CraftingRecipe;
import net.minecraft.world.item.crafting.Ingredient;
import net.minecraft.world.item.crafting.Recipe;
import net.minecraft.world.item.crafting.ShapedRecipe;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.Property;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.shapes.VoxelShape;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.SortedSet;
import java.util.TreeSet;

/**
 * Dumps the running server's block/item/entity/recipe registries into a JSON
 * file shaped like minecraft-data, so mindcraft can teach mineflayer about a
 * modpack. Writes to <gameDir>/mindcraft_mod_data.json.
 *
 * Block state ids are the whole point: mineflayer decodes chunks by state id,
 * and a modpack both appends its own states and shifts vanilla ones (a mod that
 * adds a property to leaves moves everything registered after them). Only the
 * running server knows where each state landed.
 *
 * The dump runs once and then leaves the file alone -- collision shapes and
 * harvest tools are expensive enough to be worth doing on demand rather than
 * every boot. Delete the file to regenerate it.
 */
public class DumperMod implements ModInitializer {
    private static final Logger LOGGER = LoggerFactory.getLogger("mindcraft-dumper");

    private final JsonArray blocks = new JsonArray();
    /** Distinct collision shapes, so 600,000 block states cost an int each. */
    private final Map<String, Integer> shape_ids = new HashMap<>();
    private final JsonArray shapes = new JsonArray();
    /** Shape table entries with no boxes, i.e. states you can walk through. */
    private final Set<Integer> empty_shapes = new HashSet<>();
    private final List<ItemStack> tools = new ArrayList<>();
    private MinecraftServer server;

    @Override
    public void onInitialize() {
        LOGGER.info("mindcraft dumper loaded");
        ServerLifecycleEvents.SERVER_STARTED.register(started -> {
            server = started;
            if (Files.exists(outputPath())) {
                LOGGER.info("{} already exists, delete it to regenerate", outputPath());
                return;
            }
            // Off the server thread on purpose. Asking a modded block for its
            // collision shape makes Lithium log a analysis warning per block
            // class, and on a 400-mod pack the server thread spends longer
            // inside log4j than the watchdog's 60s patience allows. Everything
            // read here (registries, recipes) is frozen by the time the server
            // has started, so a reader thread is safe -- and if it is slow,
            // it's slow on its own time.
            Thread thread = new Thread(this::dump, "mindcraft-dumper");
            thread.setDaemon(true);
            thread.setPriority(Thread.MIN_PRIORITY);
            thread.start();
        });
    }

    private void dump() {
        BuiltInRegistries.ITEM.forEach(item -> {
            if (item instanceof DiggerItem || item instanceof ShearsItem || item instanceof SwordItem) {
                tools.add(new ItemStack(item));
            }
        });
        LOGGER.info("dumping {} blocks against {} tools", BuiltInRegistries.BLOCK.size(), tools.size());
        for (Block block : BuiltInRegistries.BLOCK) {
            dumpBlock(block);
        }
        write();
    }

    private Path outputPath() {
        return FabricLoader.getInstance().getGameDir().resolve("mindcraft_mod_data.json");
    }

    private void write() {
        Path out = outputPath();
        try {
            JsonObject root = new JsonObject();
            root.addProperty("minecraft_version", SharedConstants.getCurrentVersion().getName());
            root.add("blocks", blocks);
            root.add("shapes", shapes);
            root.add("items", dumpItems());
            root.add("entities", dumpEntities());
            root.add("recipes", dumpRecipes());
            Files.writeString(out, new GsonBuilder().create().toJson(root));
            LOGGER.info("wrote {} blocks and {} shapes of mindcraft mod data to {}", blocks.size(), shapes.size(), out);
        } catch (Throwable e) {
            LOGGER.error("failed to write mindcraft mod data to " + out, e);
        }
    }

    private void dumpBlock(Block block) {
        try {
            BlockState defaultState = block.defaultBlockState();
            Collection<BlockState> states = block.getStateDefinition().getPossibleStates();

            int minStateId = Integer.MAX_VALUE;
            int maxStateId = Integer.MIN_VALUE;
            for (BlockState state : states) {
                int id = Block.BLOCK_STATE_REGISTRY.getId(state);
                minStateId = Math.min(minStateId, id);
                maxStateId = Math.max(maxStateId, id);
            }

            // Shapes indexed by state id offset, so the reader can line them up
            // with the states it decodes without re-deriving the state order.
            JsonArray state_shapes = new JsonArray();
            boolean collides = false;
            for (int id = minStateId; id <= maxStateId; id++) {
                BlockState state = Block.BLOCK_STATE_REGISTRY.byId(id);
                int shape = state == null ? 0 : shapeId(state);
                collides |= !empty_shapes.contains(shape);
                state_shapes.add(shape);
            }

            JsonObject json = new JsonObject();
            json.addProperty("id", BuiltInRegistries.BLOCK.getId(block));
            json.addProperty("name", BuiltInRegistries.BLOCK.getKey(block).toString());
            json.addProperty("displayName", displayName(block));
            json.addProperty("hardness", block.defaultDestroyTime());
            json.addProperty("resistance", block.getExplosionResistance());
            json.addProperty("stackSize", 64);
            json.addProperty("diggable", block.defaultDestroyTime() >= 0);
            json.addProperty("material", material(defaultState));
            json.addProperty("transparent", !defaultState.canOcclude());
            json.addProperty("emitLight", defaultState.getLightEmission());
            json.addProperty("filterLight", defaultState.canOcclude() ? 15 : 0);
            json.addProperty("defaultState", Block.BLOCK_STATE_REGISTRY.getId(defaultState));
            json.addProperty("minStateId", minStateId);
            json.addProperty("maxStateId", maxStateId);
            json.add("states", dumpStateProperties(defaultState));
            json.add("stateShapeIds", state_shapes);
            json.addProperty("boundingBox", collides ? "block" : "empty");
            if (defaultState.requiresCorrectToolForDrops()) {
                json.add("harvestTools", harvestTools(defaultState));
            }
            json.add("drops", new JsonArray());
            blocks.add(json);
        } catch (Throwable e) {
            // One unhappy modded block shouldn't cost us the other 18,000.
            LOGGER.error("failed to dump block " + BuiltInRegistries.BLOCK.getKey(block), e);
        }
    }

    /** Index of this state's collision boxes in the shared shape table. */
    private int shapeId(BlockState state) {
        JsonArray boxes = new JsonArray();
        try {
            VoxelShape shape = state.getCollisionShape(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
            for (AABB box : shape.toAabbs()) {
                JsonArray corners = new JsonArray();
                corners.add(round(box.minX));
                corners.add(round(box.minY));
                corners.add(round(box.minZ));
                corners.add(round(box.maxX));
                corners.add(round(box.maxY));
                corners.add(round(box.maxZ));
                boxes.add(corners);
            }
        } catch (Throwable e) {
            // Needs real world context to answer. A full cube is the safer
            // guess: the bot walks around it instead of into it.
            boxes = FULL_CUBE.deepCopy();
        }
        String key = boxes.toString();
        Integer known = shape_ids.get(key);
        if (known != null) return known;
        int id = shapes.size();
        shapes.add(boxes);
        shape_ids.put(key, id);
        if (boxes.isEmpty()) empty_shapes.add(id);
        return id;
    }

    private static final JsonArray FULL_CUBE = fullCube();

    private static JsonArray fullCube() {
        JsonArray corners = new JsonArray();
        for (double value : new double[]{0, 0, 0, 1, 1, 1}) corners.add(value);
        JsonArray boxes = new JsonArray();
        boxes.add(corners);
        return boxes;
    }

    private double round(double value) {
        return Math.round(value * 100000.0) / 100000.0;
    }

    /** Which tools actually drop this block, mineflayer's format: {itemId: true}. */
    private JsonObject harvestTools(BlockState state) {
        JsonObject harvest = new JsonObject();
        for (ItemStack tool : tools) {
            if (tool.isCorrectToolForDrops(state)) {
                harvest.addProperty(String.valueOf(BuiltInRegistries.ITEM.getId(tool.getItem())), true);
            }
        }
        return harvest;
    }

    /** minecraft-data lists a block's properties in state order; prismarine-block uses them to decode metadata. */
    private JsonArray dumpStateProperties(BlockState state) {
        JsonArray properties = new JsonArray();
        for (Property<?> property : state.getBlock().getStateDefinition().getProperties()) {
            JsonObject json = new JsonObject();
            json.addProperty("name", property.getName());
            json.addProperty("num_values", property.getPossibleValues().size());
            JsonArray values = new JsonArray();
            for (Object value : property.getPossibleValues()) {
                values.add(name(property, value));
            }
            json.add("values", values);
            json.addProperty("type", type(property));
            properties.add(json);
        }
        return properties;
    }

    private JsonArray dumpItems() {
        JsonArray items = new JsonArray();
        for (Item item : BuiltInRegistries.ITEM) {
            JsonObject json = new JsonObject();
            json.addProperty("id", BuiltInRegistries.ITEM.getId(item));
            json.addProperty("name", BuiltInRegistries.ITEM.getKey(item).toString());
            json.addProperty("displayName", item.getDescription().getString());
            json.addProperty("stackSize", item.getMaxStackSize());
            if (item.canBeDepleted()) {
                json.addProperty("maxDurability", item.getMaxDamage());
            }
            // What the bot can eat. Without this the registry's food table is
            // vanilla-only, so hunger reflexes are blind to every modded meal
            // the pack expects players to live on.
            var food = item.getFoodProperties();
            if (food != null) {
                JsonObject f = new JsonObject();
                f.addProperty("foodPoints", food.getNutrition());
                f.addProperty("saturationModifier", food.getSaturationModifier());
                json.add("food", f);
            }
            items.add(json);
        }
        return items;
    }

    private JsonArray dumpEntities() {
        JsonArray entities = new JsonArray();
        for (EntityType<?> entity : BuiltInRegistries.ENTITY_TYPE) {
            JsonObject json = new JsonObject();
            json.addProperty("id", BuiltInRegistries.ENTITY_TYPE.getId(entity));
            json.addProperty("name", BuiltInRegistries.ENTITY_TYPE.getKey(entity).toString());
            json.addProperty("displayName", entity.getDescription().getString());
            json.addProperty("width", entity.getWidth());
            json.addProperty("height", entity.getHeight());
            json.addProperty("category", entity.getCategory().getName());
            json.addProperty("attackable", attackable(entity));
            entities.add(json);
        }
        return entities;
    }

    /**
     * Crafting recipes keyed by result item id, in minecraft-data's shape:
     * shaped recipes get an inShape grid, shapeless ones an ingredient list.
     *
     * ponytail: an ingredient slot that accepts a tag (any log, any copper
     * ingot) is written as its first item. The bot crafts with that one instead
     * of whatever it happens to be carrying; the alternative is emitting the
     * cartesian product of every tag, which for this pack is millions of recipes.
     */
    private JsonObject dumpRecipes() {
        JsonObject recipes = new JsonObject();
        int count = 0;
        for (Recipe<?> recipe : server.getRecipeManager().getRecipes()) {
            try {
                if (!(recipe instanceof CraftingRecipe) || recipe.isSpecial()) continue;
                ItemStack result = recipe.getResultItem(server.registryAccess());
                if (result.isEmpty()) continue;

                JsonObject json = new JsonObject();
                JsonObject out = new JsonObject();
                out.addProperty("id", BuiltInRegistries.ITEM.getId(result.getItem()));
                out.addProperty("count", result.getCount());
                json.add("result", out);

                if (recipe instanceof ShapedRecipe shaped) {
                    JsonArray rows = new JsonArray();
                    for (int y = 0; y < shaped.getHeight(); y++) {
                        JsonArray row = new JsonArray();
                        for (int x = 0; x < shaped.getWidth(); x++) {
                            row.add(ingredientJson(shaped.getIngredients().get(y * shaped.getWidth() + x)));
                        }
                        rows.add(row);
                    }
                    json.add("inShape", rows);
                } else {
                    JsonArray ingredients = new JsonArray();
                    for (Ingredient ingredient : recipe.getIngredients()) {
                        JsonElement slot = ingredientJson(ingredient);
                        if (!slot.isJsonNull()) ingredients.add(slot);
                    }
                    if (ingredients.isEmpty()) continue;
                    json.add("ingredients", ingredients);
                }

                String key = String.valueOf(BuiltInRegistries.ITEM.getId(result.getItem()));
                if (!recipes.has(key)) recipes.add(key, new JsonArray());
                recipes.getAsJsonArray(key).add(json);
                count++;
            } catch (Throwable e) {
                LOGGER.error("failed to dump recipe " + recipe.getId(), e);
            }
        }
        LOGGER.info("dumped {} crafting recipes", count);
        return recipes;
    }

    /**
     * One ingredient slot: a bare item id when only one item fits, otherwise
     * {"any": [ids...]} listing everything the slot accepts.
     *
     * This used to write only the first item, which was a real bug and not a
     * cosmetic one. Minecraft's wooden recipes take the #planks tag, so a
     * wooden_pickaxe came out demanding minecraft:oak_planks specifically.
     * mineflayer's recipesFor() reads the same table the plan does, so a bot in
     * a frozen pine taiga holding 20 pine_planks could neither plan nor craft a
     * pickaxe. It died 18+ times without one and wrote "pine unusable" into its
     * own memory -- true of the dump, false of the server.
     *
     * The old comment here rejected "the cartesian product of every tag, which
     * for this pack is millions of recipes". That is still the right thing to
     * reject, but listing what a slot accepts is not that product: the reader
     * expands one variant per candidate rather than every combination, so a
     * 70-wood pickaxe recipe becomes 70 recipes, not 70^3.
     */
    private JsonElement ingredientJson(Ingredient ingredient) {
        if (ingredient.isEmpty()) return JsonNull.INSTANCE;
        ItemStack[] stacks = ingredient.getItems();
        if (stacks.length == 0) return JsonNull.INSTANCE;
        if (stacks.length == 1) return new JsonPrimitive(BuiltInRegistries.ITEM.getId(stacks[0].getItem()));

        // Sorted and de-duplicated so a rebuild of the same pack is byte-identical.
        SortedSet<Integer> ids = new TreeSet<>();
        for (ItemStack stack : stacks) ids.add(BuiltInRegistries.ITEM.getId(stack.getItem()));
        if (ids.size() == 1) return new JsonPrimitive(ids.first());
        JsonArray any = new JsonArray();
        for (Integer id : ids) any.add(id);
        JsonObject slot = new JsonObject();
        slot.add("any", any);
        return slot;
    }

    /**
     * Whether the bot can walk through it. The motion-blocking flag rather than
     * the collision shape, because this one is read for every block and the
     * shape lookup is the expensive part.
     */
    /**
     * Whether the server will accept an attack on this entity at all.
     *
     * Not the mob category: mods put projectiles in MobCategory.CREATURE often
     * enough that trusting it gets the bot kicked with
     * "invalid_entity_attacked" the moment it swings at a modded arrow. Vanilla
     * rejects attacks on items, experience orbs and arrows, so identify the
     * living entities instead: every one of them registers default attributes
     * (health, follow range) and nothing else does. EntityType#getBaseClass is
     * no use here -- the builder erases to Entity for everything.
     */
    private boolean attackable(EntityType<?> type) {
        return DefaultAttributes.hasSupplier(type);
    }

    /**
     * minecraft-data materials are tool tags in modern versions, which is all
     * prismarine-block uses them for (picking the dig speed multiplier).
     */
    private String material(BlockState state) {
        if (state.is(BlockTags.MINEABLE_WITH_AXE)) return "mineable/axe";
        if (state.is(BlockTags.MINEABLE_WITH_PICKAXE)) return "mineable/pickaxe";
        if (state.is(BlockTags.MINEABLE_WITH_SHOVEL)) return "mineable/shovel";
        if (state.is(BlockTags.MINEABLE_WITH_HOE)) return "mineable/hoe";
        if (state.is(BlockTags.LEAVES)) return "leaves";
        if (state.is(BlockTags.WOOL)) return "wool";
        if (state.is(BlockTags.SWORD_EFFICIENT)) return "plant";
        return "default";
    }

    private String displayName(Block block) {
        String name = block.getName().getString();
        // Mods without a server-side lang file return the raw translation key.
        return name.startsWith("block.") ? BuiltInRegistries.BLOCK.getKey(block).getPath() : name;
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private String name(Property property, Object value) {
        return property.getName((Comparable) value);
    }

    private String type(Property<?> property) {
        Class<?> type = property.getValueClass();
        if (type == Boolean.class) return "bool";
        if (type == Integer.class) return "int";
        return "enum";
    }
}
