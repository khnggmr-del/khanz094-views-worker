/**
 * Khanz094 Audio Space — Worker đếm lượt nghe
 * Tự lưu trữ bằng Cloudflare KV, không phụ thuộc dịch vụ đếm bên thứ 3 nào.
 *
 * Cần: 1 KV namespace được bind vào Worker với tên biến đúng là "VIEWS"
 * (Settings -> Variables -> KV Namespace Bindings -> Variable name: VIEWS).
 *
 * Endpoints:
 *   GET /up?ep=<safeName>     -> tăng lượt nghe của 1 tập lên 1, trả về số mới
 *   GET /count?ep=<safeName>  -> chỉ xem lượt nghe của 1 tập, KHÔNG tăng
 *   GET /counts               -> trả về TẤT CẢ lượt nghe cùng lúc (dùng cho danh sách)
 *
 * TỐI ƯU (quan trọng): /counts được gọi ở MỌI lượt tải trang chủ (bởi mọi
 * người xem), trong khi /up chỉ xảy ra khi có người thực sự bấm phát — tần
 * suất thấp hơn nhiều. Vì vậy /counts đọc từ 1 "cache tổng hợp" (1 lần đọc
 * duy nhất) thay vì liệt kê + đọc riêng từng tập (N+1 lần đọc mỗi lượt tải
 * trang) — tránh chạm giới hạn KV free tier (100.000 read/ngày) khi thư viện
 * và lượng người xem tăng lên. Cache này được cập nhật ngay trong /up.
 */

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// Key lưu cache tổng hợp — dùng tiền tố khác hẳn "views:" để không bao giờ
// trùng với key thật của 1 tập (safeName chỉ gồm a-z, 0-9, dấu gạch ngang).
const AGGREGATE_KEY = 'aggregate:all_counts';

function jsonResponse(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
}

function isValidEpisodeName(ep) {
    // Giới hạn ký tự hợp lệ để tránh key rác/tấn công — khớp với cách
    // script.js sinh ra "safeName" (chỉ chữ thường, số, dấu gạch ngang).
    return typeof ep === 'string' && /^[a-z0-9-]{1,200}$/.test(ep);
}

async function readAggregateCache(env) {
    const raw = await env.VIEWS.get(AGGREGATE_KEY);
    return raw ? JSON.parse(raw) : null;
}

async function writeAggregateCache(env, data) {
    await env.VIEWS.put(AGGREGATE_KEY, JSON.stringify(data));
}

/** Xây lại cache tổng hợp từ đầu (chỉ chạy khi cache chưa tồn tại — lần đầu
 * sau khi nâng cấp, hoặc nếu cache bị xóa nhầm). Từ lần sau /up sẽ tự giữ
 * cache luôn cập nhật, không cần quét lại toàn bộ nữa. */
async function rebuildAggregateCache(env) {
    const list = await env.VIEWS.list({ prefix: 'views:' });
    const entries = await Promise.all(
        list.keys.map(async (k) => {
            const v = await env.VIEWS.get(k.name);
            return [k.name.replace('views:', ''), parseInt(v) || 0];
        })
    );
    const data = Object.fromEntries(entries);
    await writeAggregateCache(env, data);
    return data;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;

        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: CORS_HEADERS });
        }

        if (request.method !== 'GET') {
            return jsonResponse({ error: 'Chỉ hỗ trợ GET' }, 405);
        }

        if (!env.VIEWS) {
            return jsonResponse({ error: 'Worker chưa được bind KV namespace (thiếu biến VIEWS)' }, 500);
        }

        const ep = url.searchParams.get('ep');

        if (path === '/up') {
            if (!isValidEpisodeName(ep)) return jsonResponse({ error: 'Thiếu hoặc sai định dạng tham số ep' }, 400);
            const key = `views:${ep}`;
            const current = parseInt(await env.VIEWS.get(key)) || 0;
            const updated = current + 1;
            await env.VIEWS.put(key, String(updated));

            // Cập nhật luôn cache tổng hợp để /counts không cần quét lại toàn bộ.
            const cache = (await readAggregateCache(env)) || {};
            cache[ep] = updated;
            await writeAggregateCache(env, cache);

            return jsonResponse({ ep, count: updated });
        }

        if (path === '/count') {
            if (!isValidEpisodeName(ep)) return jsonResponse({ error: 'Thiếu hoặc sai định dạng tham số ep' }, 400);
            const key = `views:${ep}`;
            const count = parseInt(await env.VIEWS.get(key)) || 0;
            return jsonResponse({ ep, count });
        }

        if (path === '/counts') {
            let data = await readAggregateCache(env);
            if (data === null) {
                // Chưa có cache (lần đầu sau khi nâng cấp) -> xây 1 lần duy nhất,
                // các lần /counts sau sẽ chỉ đọc 1 key này, không quét lại nữa.
                data = await rebuildAggregateCache(env);
            }
            return jsonResponse(data);
        }

        return jsonResponse({ error: 'Không tìm thấy endpoint. Dùng /up, /count hoặc /counts' }, 404);
    },
};
